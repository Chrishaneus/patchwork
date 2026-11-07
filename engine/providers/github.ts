import {
	EngineError,
	type PullRequest,
	type PullRequestState,
	type PullRequestSummary
} from '#lib/engine/contract.js';

export interface OpenPullRequestInput {
	/** `owner/name` */
	slug: string;
	head: string;
	base: string;
	title: string;
	body: string;
	draft: boolean;
}

interface GitHubPull {
	html_url: string;
	number: number;
	draft?: boolean;
	state?: 'open' | 'closed';
	merged?: boolean;
	merged_at?: string | null;
}

const toPullRequest = (pull: GitHubPull): PullRequest => ({
	provider: 'github',
	url: pull.html_url,
	number: pull.number,
	draft: Boolean(pull.draft),
	state: pull.merged || pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
	syncedAt: new Date().toISOString()
});

/**
 * Minimal GitHub REST client for opening pull requests. `apiUrl` is https://api.github.com, a
 * GitHub Enterprise API URL, or the local fake GitHub used for testing.
 */
export function createGitHubClient(opts: { apiUrl: string; token: string }) {
	const request = async (method: string, path: string, body?: unknown) => {
		let res: Response;
		try {
			res = await fetch(`${opts.apiUrl.replace(/\/$/, '')}${path}`, {
				method,
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${opts.token}`,
					'x-github-api-version': '2022-11-28',
					'user-agent': 'patchwork',
					...(body ? { 'content-type': 'application/json' } : {})
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(30_000)
			});
		} catch (error) {
			throw new EngineError('github_failed', `Could not reach GitHub: ${(error as Error).message}`);
		}
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, data };
	};

	const describe = (data: Record<string, unknown>) => {
		const errors = Array.isArray(data.errors)
			? (data.errors as { message?: string; field?: string; code?: string }[])
					.map((e) => e.message ?? `${e.field} ${e.code}`)
					.join('; ')
			: '';
		return [data.message, errors].filter(Boolean).join(': ');
	};

	return {
		async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
			const created = await request('POST', `/repos/${input.slug}/pulls`, {
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
				draft: input.draft
			});
			if (created.status === 201) {
				return toPullRequest(created.data as unknown as GitHubPull);
			}

			// Publishing again after a partial failure: reuse the PR that already exists.
			if (created.status === 422 && /already exists/i.test(describe(created.data))) {
				const owner = input.slug.split('/')[0];
				const existing = await request(
					'GET',
					`/repos/${input.slug}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&state=open`
				);
				const [pull] = (Array.isArray(existing.data) ? existing.data : []) as GitHubPull[];
				if (pull) return toPullRequest(pull);
			}

			const hint =
				created.status === 401
					? ' Check the GitHub token in Settings.'
					: created.status === 403 || created.status === 404
						? ' The token may not have access to this repository (it needs pull request write access).'
						: '';
			throw new EngineError(
				'github_failed',
				`GitHub refused the pull request (${created.status}): ${describe(created.data) || 'unknown error'}.${hint}`
			);
		},

		/** Current state of a pull request. */
		async getState(slug: string, number: number): Promise<PullRequestState> {
			const res = await request('GET', `/repos/${slug}/pulls/${number}`);
			if (res.status !== 200) {
				throw new EngineError(
					'github_failed',
					`GitHub couldn't read pull request #${number} (${res.status}): ${describe(res.data)}`
				);
			}
			return toPullRequest(res.data as unknown as GitHubPull).state;
		},

		/** One pull request: title, branches and head commit. */
		async get(slug: string, number: number) {
			const res = await request('GET', `/repos/${slug}/pulls/${number}`);
			if (res.status !== 200) {
				throw new EngineError(
					'invalid_pull_request',
					`GitHub couldn't find pull request #${number} in ${slug} (${res.status}).`
				);
			}
			const pr = res.data as {
				title: string;
				html_url: string;
				base: { ref: string };
				head: { ref: string; sha?: string };
			};
			return {
				title: pr.title,
				url: pr.html_url,
				baseRef: pr.base.ref,
				headRef: pr.head.ref,
				headSha: pr.head.sha ?? null
			};
		},

		/** Open pull requests, newest first. */
		async listOpen(slug: string): Promise<PullRequestSummary[]> {
			const res = await request('GET', `/repos/${slug}/pulls?state=open&per_page=50`);
			if (res.status !== 200 || !Array.isArray(res.data)) {
				throw new EngineError(
					'github_failed',
					`GitHub couldn't list pull requests (${res.status}).`
				);
			}
			return (
				res.data as {
					number: number;
					title: string;
					html_url: string;
					user?: { login?: string };
					head: { ref: string };
					base: { ref: string };
					draft?: boolean;
				}[]
			).map((p) => ({
				number: p.number,
				title: p.title,
				url: p.html_url,
				author: p.user?.login ?? null,
				headRef: p.head.ref,
				baseRef: p.base.ref,
				draft: Boolean(p.draft)
			}));
		},

		/** Post a review comment (not an approval or a change request). Returns its link. */
		async comment(slug: string, number: number, body: string): Promise<string> {
			const res = await request('POST', `/repos/${slug}/pulls/${number}/reviews`, {
				body,
				event: 'COMMENT'
			});
			if (res.status !== 200 && res.status !== 201) {
				throw new EngineError(
					'github_failed',
					`GitHub refused the review comment (${res.status}): ${describe(res.data)}`
				);
			}
			return String((res.data as { html_url?: string }).html_url ?? '');
		}
	};
}
