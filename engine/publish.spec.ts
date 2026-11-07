import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import { startFakeGitHub, type FakeGitHub, type FakePull } from '../dev/fake-github';
import type { AgentRunner } from './agent';
import { createEngine, type Engine } from './index';
import { createGitHubLikeRepo, createRepo, run as git, tempDirs } from './test-helpers';

const dirs = tempDirs();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	dirs.cleanup();
});

const editingAgent: AgentRunner = async ({ cwd }) => {
	writeFileSync(path.join(cwd, 'CHANGELOG.md'), '# Changelog\n');
	return { summary: 'Added a changelog.', costUsd: 0, turns: 1 };
};

async function fakeGitHub(repos: Record<string, string> = {}): Promise<FakeGitHub> {
	const gh = await startFakeGitHub({ repos });
	closers.push(gh.close);
	return gh;
}

function waitFor(engine: Engine, taskId: string, status: Task['status']) {
	return new Promise<Task>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && e.task.status === status) {
				stop();
				resolve(e.task);
			}
		});
	});
}

async function reviewedTask(
	opts: { githubApiUrl?: string; token?: string | null; agent?: AgentRunner } = {}
) {
	const bare = dirs.make('patchwork-remote-');
	const repo = createGitHubLikeRepo(dirs.make(), bare, 'acme/widgets');
	const dataDir = dirs.make('patchwork-data-');
	const engine = createEngine({
		dataDir,
		runAgent: opts.agent ?? editingAgent,
		githubApiUrl: opts.githubApiUrl
	});
	if (opts.token !== null) await engine.updateSettings({ githubToken: opts.token ?? 'test-token' });
	const added = await engine.addRepository({ path: repo.dir });
	const { tasks } = await engine.startRun({
		repositoryIds: [added.id],
		instruction: 'Add a changelog'
	});
	const task = await waitFor(engine, tasks[0].id, 'awaiting_review');
	return { engine, task, repo, dataDir };
}

describe('publishing', () => {
	it('commits, pushes and opens a pull request on GitHub', async () => {
		const gh = await fakeGitHub();
		const { engine, task, repo } = await reviewedTask({ githubApiUrl: gh.url });

		const published = await engine.publishTask({
			taskId: task.id,
			title: 'Add a changelog',
			body: 'Adds CHANGELOG.md.',
			draft: true
		});

		expect(published).toMatchObject({
			status: 'published',
			publishError: null,
			worktreePath: null,
			pullRequest: { number: 1, draft: true, url: `${gh.url}/acme/widgets/pull/1` }
		});
		expect(gh.pulls[0]).toMatchObject({
			repo: 'acme/widgets',
			title: 'Add a changelog',
			body: 'Adds CHANGELOG.md.',
			head: task.branch,
			base: 'main',
			draft: true
		});

		// The commit is on the remote, with the title and body as its message.
		expect(git(repo.bareDir, 'log', '-1', '--format=%s%n%n%b', task.branch)).toBe(
			'Add a changelog\n\nAdds CHANGELOG.md.'
		);
		expect(git(repo.bareDir, 'show', `${task.branch}:CHANGELOG.md`)).toBe('# Changelog');
		// The worktree is gone, the local branch stays, and the diff is still available.
		expect(existsSync(task.worktreePath!)).toBe(false);
		expect(git(repo.dir, 'branch', '--list', task.branch)).toContain(task.branch);
		expect((await engine.getTaskDiff({ taskId: task.id })).patch).toContain('+# Changelog');

		await expect(engine.discardTask({ taskId: task.id })).rejects.toMatchObject({
			code: 'invalid_state'
		});
	});

	it('needs a GitHub token for GitHub remotes, before touching anything', async () => {
		const prev = { a: process.env.GITHUB_TOKEN, b: process.env.GH_TOKEN };
		delete process.env.GITHUB_TOKEN;
		delete process.env.GH_TOKEN;
		try {
			const { engine, task } = await reviewedTask({ token: null });
			await expect(
				engine.publishTask({ taskId: task.id, title: 'x', body: '' })
			).rejects.toMatchObject({
				code: 'github_token_missing'
			});
			expect((await engine.getRun({ id: task.runId })).tasks[0].status).toBe('awaiting_review');
		} finally {
			if (prev.a) process.env.GITHUB_TOKEN = prev.a;
			if (prev.b) process.env.GH_TOKEN = prev.b;
		}
	});

	it('only pushes when the remote is not on GitHub', async () => {
		const bare = dirs.make('patchwork-remote-');
		git(bare, 'init', '-q', '--bare', '-b', 'main');
		const repoDir = createRepo(dirs.make(), { remote: bare });
		git(repoDir, 'push', '-q', 'origin', 'main');
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), runAgent: editingAgent });
		const added = await engine.addRepository({ path: repoDir });
		const { tasks } = await engine.startRun({ repositoryIds: [added.id], instruction: 'x' });
		const task = await waitFor(engine, tasks[0].id, 'awaiting_review');

		const published = await engine.publishTask({
			taskId: task.id,
			title: 'Add a changelog',
			body: ''
		});

		expect(published).toMatchObject({ status: 'published', pullRequest: null });
		expect(git(bare, 'log', '-1', '--format=%s', task.branch)).toBe('Add a changelog');
	});

	it('keeps the task in review when GitHub fails, and a retry finishes the job', async () => {
		const { task, dataDir, repo } = await reviewedTask({ githubApiUrl: 'http://127.0.0.1:9' });
		const broken = createEngine({
			dataDir,
			runAgent: editingAgent,
			githubApiUrl: 'http://127.0.0.1:9'
		});
		await broken.updateSettings({ githubToken: 'test-token' });

		const failed = await broken.publishTask({
			taskId: task.id,
			title: 'Add a changelog',
			body: ''
		});
		expect(failed.status).toBe('awaiting_review');
		expect(failed.publishError?.code).toBe('github_failed');
		expect(failed.pushedAt).not.toBeNull();

		// Fix the configuration and publish again: no second commit, the PR gets opened.
		const gh = await fakeGitHub({ 'acme/widgets': repo.bareDir });
		const fixed = createEngine({ dataDir, runAgent: editingAgent, githubApiUrl: gh.url });
		await fixed.updateSettings({ githubToken: 'test-token' });
		const published = await fixed.publishTask({
			taskId: task.id,
			title: 'Add a changelog',
			body: ''
		});

		expect(published.status).toBe('published');
		expect(published.commitSha).toBe(failed.commitSha);
		expect(gh.pulls).toHaveLength(1);
	});

	it('reuses a pull request that already exists for the branch', async () => {
		const gh = await fakeGitHub();
		const { engine, task } = await reviewedTask({ githubApiUrl: gh.url });
		gh.pulls.push({
			repo: 'acme/widgets',
			number: 7,
			title: 'Earlier',
			body: '',
			head: task.branch,
			base: 'main',
			draft: false,
			state: 'open',
			merged: false,
			html_url: `${gh.url}/acme/widgets/pull/7`,
			created_at: ''
		} satisfies FakePull);

		const published = await engine.publishTask({
			taskId: task.id,
			title: 'Add a changelog',
			body: ''
		});

		expect(published.pullRequest).toMatchObject({ number: 7 });
	});

	it('refuses to publish when the agent changed nothing', async () => {
		const gh = await fakeGitHub();
		const idle: AgentRunner = async () => ({ summary: 'Nothing to do.', costUsd: 0, turns: 1 });
		const { engine, task } = await reviewedTask({ githubApiUrl: gh.url, agent: idle });

		const result = await engine.publishTask({ taskId: task.id, title: 'x', body: '' });

		expect(result.status).toBe('awaiting_review');
		expect(result.publishError?.code).toBe('nothing_to_publish');
		expect(gh.pulls).toHaveLength(0);
	});
});

describe('providerAuthEnv', () => {
	it('adds the token for HTTPS remotes of the matching provider only', async () => {
		const { providerAuthEnv } = await import('./providers');
		const decode = (env: Record<string, string>) =>
			Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ').pop()!, 'base64').toString();

		const github = providerAuthEnv('https://github.com/acme/widgets.git', 'github', 'tok');
		expect(github.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
		expect(decode(github)).toBe('x-access-token:tok');

		const gitlab = providerAuthEnv('https://gitlab.example.com/team/app.git', 'gitlab', 'tok');
		expect(gitlab.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.example.com/.extraheader');
		expect(decode(gitlab)).toBe('oauth2:tok');

		expect(providerAuthEnv('git@github.com:acme/widgets.git', 'github', 'tok')).toEqual({});
		expect(providerAuthEnv('https://evil.example.com/acme/widgets.git', 'github', 'tok')).toEqual(
			{}
		);
		expect(providerAuthEnv('https://github.com/acme/widgets.git', 'github', null)).toEqual({});
	});
});
