import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EngineEvent } from '#lib/engine/contract.js';
import { startFakeGitHub, type FakeGitHub } from '../../dev/fake-github';
import { createEngine, type Engine } from '../index';
import { createRepo, run as git, tempDirs } from '../test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

let gh: FakeGitHub;
beforeAll(async () => {
	gh = await startFakeGitHub({
		user: { login: 'octo-dev' },
		repos: { 'acme/widgets': '/nowhere' }
	});
});
afterAll(() => gh.close());

function engineWithGitHub(extra: Partial<Parameters<typeof createEngine>[0]> = {}) {
	return createEngine({
		dataDir: dirs.make('patchwork-data-'),
		githubWebUrl: gh.url,
		githubApiUrl: gh.url,
		pullRequestSyncMs: 0,
		...extra
	});
}

function nextLogin(engine: Engine) {
	return new Promise<Extract<EngineEvent, { type: 'github.login' }>>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'github.login') {
				stop();
				resolve(e);
			}
		});
	});
}

/** A bare repository with one commit on main, to clone from. */
function bareWithCommit() {
	const bare = dirs.make('patchwork-bare-');
	git(bare, 'init', '-q', '--bare', '-b', 'main');
	const seed = createRepo(dirs.make(), { remote: bare });
	git(seed, 'push', '-q', 'origin', 'main');
	return bare;
}

describe('Sign in with GitHub (device flow)', () => {
	it('needs a client ID', async () => {
		await expect(engineWithGitHub().startGitHubLogin({})).rejects.toMatchObject({
			code: 'github_login_unavailable'
		});
	});

	it('signs in after approval, lists repositories, and signs out', async () => {
		const engine = engineWithGitHub({ githubClientId: 'Iv23liTestClient' });
		expect((await engine.getSettings({})).githubClientId).toEqual({
			value: 'Iv23liTestClient',
			source: 'environment'
		});

		const start = await engine.startGitHubLogin({});
		expect(start.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
		expect(start.verificationUri).toBe(`${gh.url}/login/device`);

		const done = nextLogin(engine);
		gh.approveDevice();
		expect(await done).toMatchObject({ status: 'signed_in' });
		expect((await engine.getSettings({})).githubAccount).toEqual({
			login: 'octo-dev',
			avatarUrl: null
		});

		const repos = await engine.listGitHubRepositories({});
		expect(repos).toEqual([
			expect.objectContaining({
				fullName: 'acme/widgets',
				cloneUrl: 'https://github.com/acme/widgets.git'
			})
		]);

		const signedOut = await engine.signOutGitHub({});
		expect(signedOut.githubAccount).toBeNull();
		await expect(engine.listGitHubRepositories({})).rejects.toMatchObject({
			code: 'github_not_signed_in'
		});
	});

	it('reports a denied sign-in', async () => {
		const engine = engineWithGitHub();
		await engine.updateSettings({ githubClientId: 'Iv23liSavedClient' });
		await engine.startGitHubLogin({});
		const done = nextLogin(engine);
		gh.approveDevice('deny');
		expect(await done).toMatchObject({ status: 'denied' });
		expect((await engine.getSettings({})).githubAccount).toBeNull();
	});

	it('validates the client ID setting', async () => {
		await expect(
			engineWithGitHub().updateSettings({ githubClientId: 'not valid!' })
		).rejects.toMatchObject({
			code: 'invalid_input'
		});
	});
});

describe('adding repositories by URL', () => {
	it('clones into the data folder, runs changes there, and deletes the copy on remove', async () => {
		const dataDir = dirs.make('patchwork-data-');
		const engine = createEngine({
			dataDir,
			pullRequestSyncMs: 0,
			runAgent: async ({ cwd }) => {
				writeFileSync(path.join(cwd, 'x.txt'), 'x\n');
				return { summary: 'ok', costUsd: 0, turns: 1 };
			}
		});
		const bare = bareWithCommit();

		const repo = await engine.addRepositoryFromUrl({ url: `file://${bare}` });

		expect(repo).toMatchObject({ managed: true, defaultBranch: 'main' });
		expect(repo.path.startsWith(path.join(dataDir, 'clones'))).toBe(true);
		await expect(engine.addRepositoryFromUrl({ url: `file://${bare}` })).rejects.toMatchObject({
			code: 'already_added'
		});

		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		const done = await new Promise<string>((resolve) =>
			engine.subscribe((e) => {
				if (
					e.type === 'task.updated' &&
					e.task.id === tasks[0].id &&
					e.task.status === 'awaiting_review'
				)
					resolve(e.task.status);
			})
		);
		expect(done).toBe('awaiting_review');

		await engine.removeRepository({ id: repo.id });
		expect(existsSync(repo.path)).toBe(false);
	});

	it('recognises GitHub URLs (cloned through a URL rewrite, nothing leaves the machine)', async () => {
		const bare = bareWithCommit();
		const gitconfig = path.join(dirs.make('patchwork-gitconfig-'), 'config');
		writeFileSync(
			gitconfig,
			`[url "${bare}"]\n\tinsteadOf = https://github.com/acme/widgets.git\n`
		);
		const previous = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = gitconfig;
		try {
			const engine = engineWithGitHub();
			const repo = await engine.addRepositoryFromUrl({
				url: 'https://github.com/acme/widgets.git'
			});
			expect(repo).toMatchObject({
				managed: true,
				provider: 'github',
				slug: 'acme/widgets',
				remoteUrl: 'https://github.com/acme/widgets.git'
			});
			expect(repo.path).toMatch(/clones\/github\.com\/acme\/widgets$/);
		} finally {
			if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = previous;
		}
	});

	it('reports clone failures and leaves nothing behind', async () => {
		const dataDir = dirs.make('patchwork-data-');
		const engine = createEngine({ dataDir, pullRequestSyncMs: 0 });
		await expect(
			engine.addRepositoryFromUrl({ url: 'https://127.0.0.1:9/acme/missing.git' })
		).rejects.toMatchObject({ code: 'clone_failed' });
		const clones = path.join(dataDir, 'clones');
		const leftovers = existsSync(clones)
			? readdirSync(clones, { recursive: true }).filter((p) => String(p).endsWith('missing'))
			: [];
		expect(leftovers).toEqual([]);
	});

	it('rejects malformed URLs and option injection', async () => {
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), pullRequestSyncMs: 0 });
		for (const url of ['', 'not a url', '--upload-pack=touch /tmp/x', 'ftp://example.com/x.git']) {
			await expect(engine.addRepositoryFromUrl({ url })).rejects.toMatchObject({
				code: 'invalid_url'
			});
		}
	});

	it('on a server without mounted folders, allows only remote URLs', async () => {
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			pullRequestSyncMs: 0,
			localPaths: false
		});
		expect(await engine.getEngineInfo({})).toEqual({ localPaths: false, repositoryRoots: [] });

		await expect(engine.addRepository({ path: createRepo(dirs.make()) })).rejects.toMatchObject({
			code: 'local_paths_disabled'
		});
		for (const url of [`file://${bareWithCommit()}`, '/srv/git/repo.git']) {
			await expect(engine.addRepositoryFromUrl({ url })).rejects.toMatchObject({
				code: 'invalid_url'
			});
		}
	});
});

describe('sign-in errors', () => {
	it('explains a GitHub App without Device Flow', async () => {
		const { createServer } = await import('node:http');
		// A GitHub that answers like one whose app has Device Flow turned off.
		const server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					error: 'device_flow_disabled',
					error_description: 'Device Flow must be explicitly enabled for this App'
				})
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
		try {
			const engine = createEngine({
				dataDir: dirs.make('patchwork-data-'),
				githubWebUrl: url,
				githubApiUrl: url,
				githubClientId: 'Iv23liNoDeviceFlow',
				pullRequestSyncMs: 0
			});
			const error = await engine.startGitHubLogin({}).catch((e: unknown) => e);
			expect(error).toMatchObject({ code: 'github_failed' });
			expect((error as Error).message).toContain('Turn on "Enable Device Flow"');
		} finally {
			server.close();
		}
	});
});

describe('sign-in status', () => {
	it('reports a waiting sign-in, and stops reporting it once cancelled', async () => {
		const engine = engineWithGitHub({ githubClientId: 'Iv23liStatusClient' });
		expect(await engine.getGitHubLoginStatus({})).toEqual({ pending: false, account: null });
		await engine.startGitHubLogin({});
		expect((await engine.getGitHubLoginStatus({})).pending).toBe(true);
		await engine.cancelGitHubLogin({});
		expect((await engine.getGitHubLoginStatus({})).pending).toBe(false);
	});
});
