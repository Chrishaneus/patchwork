// A fake GitHub for local testing. It answers the pull-request endpoints of GitHub's REST API and
// shows each PR, with its diff, at http://127.0.0.1:<port>/. Nothing leaves this machine.
//
// Used by the tests and by `npm run sandbox`. Run on its own with:
//   node dev/fake-github.ts [--port 4010] [--repo owner/name=/path/to/bare.git ...]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

export interface FakePull {
	repo: string;
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
	draft: boolean;
	state: 'open' | 'closed';
	merged: boolean;
	html_url: string;
	created_at: string;
}

export interface FakeGitHubOptions {
	port?: number;
	host?: string;
	/**
	 * Maps `owner/name` to the bare repository that plays its remote, so the server can check that
	 * a pushed branch exists (like GitHub does) and show the diff.
	 */
	repos?: Record<string, string>;
	/** Keep PRs in this JSON file so they survive restarts. */
	stateFile?: string;
	/** The account "Sign in with GitHub" signs in as. */
	user?: { login: string; avatarUrl?: string | null };
	/**
	 * Repositories listed for the signed-in user. Defaults to the `repos` keys, cloned from
	 * https://github.com/<name>.git.
	 */
	userRepos?: { fullName: string; cloneUrl?: string; private?: boolean; description?: string }[];
}

export interface FakeGitHub {
	url: string;
	pulls: FakePull[];
	/** Reviews posted on pull requests. */
	reviews: {
		repo: string;
		number: number;
		body: string;
		event: string;
		html_url: string;
		commit_id?: string;
		comments: { path: string; line: number; start_line?: number; side?: string; body: string }[];
	}[];
	/** Set a PR's state, like merging or closing it on GitHub. */
	setState: (repo: string, number: number, state: 'open' | 'closed' | 'merged') => void;
	/** Approve (or deny) the most recent device-flow sign-in, like clicking the button on GitHub. */
	approveDevice: (decision?: 'approve' | 'deny') => string | null;
	close: () => Promise<void>;
}

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
	);

function git(bare: string, args: string[]): string | null {
	try {
		return execFileSync('git', args, {
			cwd: bare,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
	} catch {
		return null;
	}
}

/** A stored PR in the shape GitHub's API returns. */
function toApi(pull: FakePull, bare: string | undefined) {
	const sha = bare
		? git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${pull.head}`])?.trim()
		: null;
	return {
		...pull,
		user: { login: 'sandbox-user' },
		head: { ref: pull.head, sha: sha ?? null },
		base: { ref: pull.base }
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, title: string, body: string) {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111}
a{color:#0969da}pre{background:#f6f8fa;padding:1rem;overflow:auto;border-radius:6px;font-size:13px}
.add{color:#116329}.del{color:#82071e}.meta{color:#666}
.badge{border:1px solid #ccc;border-radius:999px;padding:0 .5rem;font-size:12px}</style>
<p class="meta">Fake GitHub (local test server)</p>${body}`);
}

/** Merge head into base inside a bare repository, like GitHub's merge button. */
function mergeInBare(bare: string, pull: FakePull) {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 'Fake GitHub',
		GIT_AUTHOR_EMAIL: 'fake@github.local',
		GIT_COMMITTER_NAME: 'Fake GitHub',
		GIT_COMMITTER_EMAIL: 'fake@github.local'
	};
	try {
		const tree = execFileSync('git', ['merge-tree', '--write-tree', pull.base, pull.head], {
			cwd: bare,
			encoding: 'utf8',
			env
		})
			.trim()
			.split('\n')[0];
		const commit = execFileSync(
			'git',
			[
				'commit-tree',
				tree,
				'-p',
				pull.base,
				'-p',
				pull.head,
				'-m',
				`Merge pull request #${pull.number} from ${pull.head}`
			],
			{ cwd: bare, encoding: 'utf8', env }
		).trim();
		execFileSync('git', ['update-ref', `refs/heads/${pull.base}`, commit], { cwd: bare, env });
	} catch {
		// Conflicts: leave the branches alone; the PR is still marked merged for testing.
	}
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
	const { port = 0, host = '127.0.0.1', repos = {}, stateFile } = options;
	const pulls: FakePull[] =
		stateFile && existsSync(stateFile)
			? (JSON.parse(readFileSync(stateFile, 'utf8')) as FakePull[])
			: [];
	const reviews: FakeGitHub['reviews'] = [];
	const save = () => stateFile && writeFileSync(stateFile, JSON.stringify(pulls, null, 2));
	let baseUrl = '';

	// Device-flow sign-ins: device code -> state.
	const devices = new Map<string, { userCode: string; state: 'pending' | 'approved' | 'denied' }>();
	const tokens = new Set<string>();
	const user = options.user ?? { login: 'sandbox-user', avatarUrl: null };

	async function readForm(
		req: import('node:http').IncomingMessage
	): Promise<Record<string, string>> {
		let raw = '';
		for await (const chunk of req) raw += chunk;
		if ((req.headers['content-type'] ?? '').includes('json')) return JSON.parse(raw || '{}');
		return Object.fromEntries(new URLSearchParams(raw));
	}

	function approveDevice(
		decision: 'approve' | 'deny' = 'approve',
		userCode?: string
	): string | null {
		const entries = [...devices.entries()].filter(([, d]) => d.state === 'pending');
		const match = userCode
			? entries.find(([, d]) => d.userCode === userCode.trim().toUpperCase())
			: entries.at(-1);
		if (!match) return null;
		match[1].state = decision === 'approve' ? 'approved' : 'denied';
		return match[1].userCode;
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const parts = url.pathname.split('/').filter(Boolean);

		// Device flow, step 1: the app asks for a code.
		if (url.pathname === '/login/device/code' && req.method === 'POST') {
			const form = await readForm(req);
			if (!form.client_id) return sendJson(res, 200, { error: 'unauthorized_client' });
			const deviceCode = `dev_${Math.random().toString(36).slice(2)}`;
			const userCode =
				`${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
			devices.set(deviceCode, { userCode, state: 'pending' });
			return sendJson(res, 200, {
				device_code: deviceCode,
				user_code: userCode,
				verification_uri: `${baseUrl}/login/device`,
				expires_in: 900,
				// Real GitHub says 5 seconds; quick here so tests don't wait.
				interval: 0.2
			});
		}
		// Device flow, step 2: the app polls for the token.
		if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
			const form = await readForm(req);
			const device = devices.get(form.device_code ?? '');
			if (!device) return sendJson(res, 200, { error: 'incorrect_device_code' });
			if (device.state === 'denied') return sendJson(res, 200, { error: 'access_denied' });
			if (device.state === 'pending') return sendJson(res, 200, { error: 'authorization_pending' });
			devices.delete(form.device_code);
			const token = `ghu_fake_${Math.random().toString(36).slice(2)}`;
			tokens.add(token);
			return sendJson(res, 200, { access_token: token, token_type: 'bearer', scope: '' });
		}
		// Device flow, in the browser: enter the code and approve, like github.com/login/device.
		if (url.pathname === '/login/device') {
			if (req.method === 'POST') {
				const form = await readForm(req);
				const code = approveDevice(form.decision === 'deny' ? 'deny' : 'approve', form.user_code);
				return sendHtml(
					res,
					'Device activation',
					code
						? `<h1>${form.decision === 'deny' ? 'Denied' : 'Approved'}</h1><p>You can go back to Patchwork.</p>`
						: '<h1>Unknown code</h1><p><a href="/login/device">Try again</a></p>'
				);
			}
			return sendHtml(
				res,
				'Device activation',
				`<h1>Device activation</h1><p>Enter the code shown in Patchwork to sign in as <b>${escapeHtml(user.login)}</b>.</p>
<form method="post"><input name="user_code" placeholder="XXXX-XXXX" autofocus>
<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`
			);
		}
		// The signed-in user and their repositories.
		if ((url.pathname === '/user' || url.pathname === '/user/repos') && req.method === 'GET') {
			const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
			if (!tokens.has(token)) return sendJson(res, 401, { message: 'Bad credentials' });
			if (url.pathname === '/user')
				return sendJson(res, 200, { login: user.login, avatar_url: user.avatarUrl ?? null });
			const list =
				options.userRepos ??
				Object.keys(repos).map((fullName) => ({
					fullName,
					cloneUrl: undefined,
					private: true,
					description: undefined
				}));
			return sendJson(
				res,
				200,
				list.map((r) => ({
					full_name: r.fullName,
					clone_url: r.cloneUrl ?? `https://github.com/${r.fullName}.git`,
					private: r.private ?? false,
					description: r.description ?? null,
					updated_at: new Date().toISOString()
				}))
			);
		}

		// API: GET /repos/:owner/:repo/pulls/:number
		if (
			parts[0] === 'repos' &&
			parts[3] === 'pulls' &&
			parts.length === 5 &&
			req.method === 'GET'
		) {
			if (!req.headers.authorization?.startsWith('Bearer ')) {
				return sendJson(res, 401, { message: 'Requires authentication' });
			}
			const pull = pulls.find(
				(p) => p.repo === `${parts[1]}/${parts[2]}` && p.number === Number(parts[4])
			);
			return pull
				? sendJson(res, 200, toApi(pull, repos[pull.repo]))
				: sendJson(res, 404, { message: 'Not Found' });
		}

		// API: POST /repos/:owner/:repo/pulls/:number/reviews
		if (
			parts[0] === 'repos' &&
			parts[3] === 'pulls' &&
			parts[5] === 'reviews' &&
			parts.length === 6 &&
			req.method === 'POST'
		) {
			if (!req.headers.authorization?.startsWith('Bearer ')) {
				return sendJson(res, 401, { message: 'Requires authentication' });
			}
			const repo = `${parts[1]}/${parts[2]}`;
			const pull = pulls.find((p) => p.repo === repo && p.number === Number(parts[4]));
			if (!pull) return sendJson(res, 404, { message: 'Not Found' });
			const input = (await readForm(req)) as {
				body?: string;
				event?: string;
				commit_id?: string;
				comments?: FakeGitHub['reviews'][number]['comments'];
			};
			const comments = input.comments ?? [];
			// Like GitHub: a line comment needs a line and a path.
			if (comments.some((c) => !c.path || !(c.line >= 1))) {
				return sendJson(res, 422, { message: 'Unprocessable Entity' });
			}
			const review = {
				repo,
				number: pull.number,
				body: input.body ?? '',
				event: input.event ?? 'COMMENT',
				html_url: `${pull.html_url}#pullrequestreview-${reviews.length + 1}`,
				commit_id: input.commit_id,
				comments
			};
			reviews.push(review);
			return sendJson(res, 200, { id: reviews.length, html_url: review.html_url });
		}

		// Web: merge or close a PR from its page.
		if (
			parts.length === 5 &&
			parts[2] === 'pull' &&
			req.method === 'POST' &&
			['merge', 'close'].includes(parts[4])
		) {
			const repo = `${parts[0]}/${parts[1]}`;
			const pull = pulls.find((p) => p.repo === repo && p.number === Number(parts[3]));
			if (!pull) return sendJson(res, 404, { message: 'Not Found' });
			if (parts[4] === 'merge' && repos[repo]) mergeInBare(repos[repo], pull);
			setState(repo, pull.number, parts[4] === 'merge' ? 'merged' : 'closed');
			res.writeHead(303, { location: `/${repo}/pull/${pull.number}` });
			return res.end();
		}

		// API: POST /repos/:owner/:repo/pulls, GET /repos/:owner/:repo/pulls?head=owner:branch
		if (parts[0] === 'repos' && parts[3] === 'pulls' && parts.length === 4) {
			if (!req.headers.authorization?.startsWith('Bearer ')) {
				return sendJson(res, 401, { message: 'Requires authentication' });
			}
			const repo = `${parts[1]}/${parts[2]}`;
			if (req.method === 'GET') {
				const head = url.searchParams.get('head')?.split(':').pop();
				const state = url.searchParams.get('state');
				return sendJson(
					res,
					200,
					pulls
						.filter(
							(p) =>
								p.repo === repo &&
								(!head || p.head === head) &&
								(!state || state === 'all' || p.state === state)
						)
						.map((p) => toApi(p, repos[p.repo]))
				);
			}
			let raw = '';
			for await (const chunk of req) raw += chunk;
			const input = JSON.parse(raw || '{}') as Partial<FakePull>;
			if (!input.title || !input.head || !input.base) {
				return sendJson(res, 422, {
					message: 'Validation Failed',
					errors: [{ message: 'title, head and base are required' }]
				});
			}
			const bare = repos[repo];
			if (bare && !git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.head}`])) {
				return sendJson(res, 422, {
					message: 'Validation Failed',
					errors: [{ field: 'head', code: 'invalid' }]
				});
			}
			if (pulls.some((p) => p.repo === repo && p.head === input.head && p.state === 'open')) {
				return sendJson(res, 422, {
					message: 'Validation Failed',
					errors: [{ message: `A pull request already exists for ${parts[1]}:${input.head}.` }]
				});
			}
			const number = pulls.filter((p) => p.repo === repo).length + 1;
			const pull: FakePull = {
				repo,
				number,
				title: input.title,
				body: input.body ?? '',
				head: input.head,
				base: input.base,
				draft: Boolean(input.draft),
				state: 'open',
				merged: false,
				html_url: `${baseUrl}/${repo}/pull/${number}`,
				created_at: new Date().toISOString()
			};
			pulls.push(pull);
			save();
			// Like GitHub: the PR's head is also readable as refs/pull/<n>/head.
			if (bare) git(bare, ['update-ref', `refs/pull/${number}/head`, `refs/heads/${input.head}`]);
			return sendJson(res, 201, toApi(pull, bare));
		}

		// Web: one PR with its diff.
		if (parts.length === 4 && parts[2] === 'pull') {
			const repo = `${parts[0]}/${parts[1]}`;
			const pull = pulls.find((p) => p.repo === repo && p.number === Number(parts[3]));
			if (!pull) return sendJson(res, 404, { message: 'Not Found' });
			const diff = repos[repo] ? git(repos[repo], ['diff', `${pull.base}...${pull.head}`]) : null;
			const diffHtml = (diff ?? '(no local remote configured for this repository)')
				.split('\n')
				.map((l) => {
					const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
					return `<span class="${cls}">${escapeHtml(l)}</span>`;
				})
				.join('\n');
			return sendHtml(
				res,
				pull.title,
				`<p><a href="/">All pull requests</a></p>
<h1>${escapeHtml(pull.title)} <span class="meta">#${pull.number}</span></h1>
<p class="meta">${escapeHtml(repo)} · <b>${escapeHtml(pull.head)}</b> → ${escapeHtml(pull.base)}
${pull.draft ? '<span class="badge">Draft</span>' : ''}
<span class="badge">${pull.merged ? 'Merged' : pull.state === 'closed' ? 'Closed' : 'Open'}</span></p>
${
	pull.state === 'open'
		? `<form method="post" action="/${repo}/pull/${pull.number}/merge" style="display:inline"><button>Merge</button></form>
<form method="post" action="/${repo}/pull/${pull.number}/close" style="display:inline"><button>Close</button></form>`
		: ''
}
<pre style="white-space:pre-wrap">${escapeHtml(pull.body) || '(no description)'}</pre>
<h2>Changes</h2><pre>${diffHtml}</pre>`
			);
		}

		// Web: all PRs.
		if (parts.length === 0) {
			const rows = [...pulls]
				.reverse()
				.map(
					(p) =>
						`<li><a href="${p.html_url}">${escapeHtml(p.repo)}#${p.number}</a> ${escapeHtml(p.title)} ${p.draft ? '<span class="badge">Draft</span>' : ''}</li>`
				)
				.join('');
			return sendHtml(
				res,
				'Pull requests',
				`<h1>Pull requests</h1><ul>${rows || '<li class="meta">None yet.</li>'}</ul>`
			);
		}

		sendJson(res, 404, { message: 'Not Found' });
	});

	function setState(repo: string, number: number, state: 'open' | 'closed' | 'merged') {
		const pull = pulls.find((p) => p.repo === repo && p.number === number);
		if (!pull) return;
		pull.state = state === 'open' ? 'open' : 'closed';
		pull.merged = state === 'merged';
		save();
	}

	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	baseUrl = `http://${host}:${(server.address() as AddressInfo).port}`;
	// Links stored earlier may point at an old port.
	for (const p of pulls) p.html_url = `${baseUrl}/${p.repo}/pull/${p.number}`;

	return {
		url: baseUrl,
		pulls,
		reviews,
		setState,
		approveDevice: (decision = 'approve') => approveDevice(decision),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const args = process.argv.slice(2);
	const portIndex = args.indexOf('--port');
	const repos: Record<string, string> = {};
	args.forEach((arg, i) => {
		if (arg !== '--repo') return;
		const [name, bare] = (args[i + 1] ?? '').split('=');
		if (name && bare) repos[name] = bare;
	});
	const gh = await startFakeGitHub({
		port: portIndex >= 0 ? Number(args[portIndex + 1]) : 4010,
		repos
	});
	console.log(`Fake GitHub on ${gh.url}`);
}
