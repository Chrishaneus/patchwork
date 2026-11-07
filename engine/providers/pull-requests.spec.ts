import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import { startFakeGitHub } from '../../dev/fake-github';
import { startFakeGitLab } from '../../dev/fake-gitlab';
import type { AgentRunInput, AgentRunner } from '../agent/runner';
import { createEngine, type Engine } from '../index';
import { createGitHubLikeRepo, createHostedLikeRepo, run as git, tempDirs } from '../test-helpers';

const dirs = tempDirs();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	dirs.cleanup();
});

function waitFor(engine: Engine, taskId: string, statuses: Task['status'][]) {
	return new Promise<Task>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status)) {
				stop();
				resolve(e.task);
			}
		});
	});
}

/** Writes one numbered file per call. */
function recordingAgent() {
	const prompts: string[] = [];
	const agent: AgentRunner = async ({ cwd, instruction }: AgentRunInput) => {
		prompts.push(instruction);
		writeFileSync(path.join(cwd, `step-${prompts.length}.txt`), `step ${prompts.length}\n`);
		return { summary: `Summary after step ${prompts.length}.`, costUsd: 0.1, turns: 2 };
	};
	return { agent, prompts };
}

describe('pull request status sync', () => {
	it('reads merged and closed states from GitHub', async () => {
		const bare = dirs.make('patchwork-remote-');
		const gh = await startFakeGitHub({ repos: { 'acme/widgets': bare } });
		closers.push(gh.close);
		const repoDir = createGitHubLikeRepo(dirs.make(), bare, 'acme/widgets').dir;
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			runAgent: recordingAgent().agent,
			githubApiUrl: gh.url,
			pullRequestSyncMs: 0
		});
		await engine.updateSettings({ githubToken: 'tok' });
		const repo = await engine.addRepository({ path: repoDir });
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		await waitFor(engine, tasks[0].id, ['awaiting_review']);
		const published = await engine.publishTask({ taskId: tasks[0].id, title: 'x', body: '' });
		expect(published.pullRequest).toMatchObject({ provider: 'github', state: 'open' });

		expect(await engine.syncPullRequests({})).toEqual({ updated: 0 });
		gh.setState('acme/widgets', 1, 'merged');
		expect(await engine.syncPullRequests({})).toEqual({ updated: 1 });

		const [run] = await engine.listRuns({});
		expect(run.tasks[0].pullRequest).toMatchObject({ state: 'merged' });
		expect(run.tasks[0].pullRequest?.syncedAt).not.toBeNull();
	});
});

describe('GitLab', () => {
	async function gitlabSetup(token: string | null = 'glpat-test') {
		const gl = await startFakeGitLab();
		closers.push(gl.close);
		const bare = dirs.make('patchwork-remote-');
		const repoDir = createHostedLikeRepo(
			dirs.make(),
			bare,
			'https://gitlab.com/acme/platform/api.git'
		).dir;
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			runAgent: recordingAgent().agent,
			gitlabApiUrl: gl.apiUrl,
			pullRequestSyncMs: 0
		});
		const prev = process.env.GITLAB_TOKEN;
		delete process.env.GITLAB_TOKEN;
		if (token) await engine.updateSettings({ gitlabToken: token });
		const repo = await engine.addRepository({ path: repoDir });
		expect(repo).toMatchObject({ provider: 'gitlab', slug: 'acme/platform/api' });
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		const task = await waitFor(engine, tasks[0].id, ['awaiting_review']);
		if (prev) process.env.GITLAB_TOKEN = prev;
		return { gl, bare, engine, task };
	}

	it('pushes and opens a merge request, and syncs its state', async () => {
		const { gl, bare, engine, task } = await gitlabSetup();

		const published = await engine.publishTask({
			taskId: task.id,
			title: 'Add steps',
			body: 'Body.',
			draft: true
		});

		expect(published.pullRequest).toMatchObject({
			provider: 'gitlab',
			number: 1,
			draft: true,
			state: 'open'
		});
		expect(gl.mergeRequests[0]).toMatchObject({
			project: 'acme/platform/api',
			title: 'Draft: Add steps',
			description: 'Body.',
			source_branch: task.branch,
			target_branch: 'main'
		});
		expect(git(bare, 'log', '-1', '--format=%s', task.branch)).toBe('Add steps');

		gl.setState('acme/platform/api', 1, 'closed');
		await engine.syncPullRequests({});
		expect((await engine.getRun({ id: task.runId })).tasks[0].pullRequest?.state).toBe('closed');
	});

	it('reuses an open merge request for the branch', async () => {
		const { gl, engine, task } = await gitlabSetup();
		gl.mergeRequests.push({
			project: 'acme/platform/api',
			iid: 5,
			title: 'Earlier',
			description: '',
			source_branch: task.branch,
			target_branch: 'main',
			state: 'opened',
			draft: false,
			web_url: 'http://gitlab.test/acme/platform/api/-/merge_requests/5'
		});
		const published = await engine.publishTask({ taskId: task.id, title: 'x', body: '' });
		expect(published.pullRequest?.number).toBe(5);
	});

	it('needs a GitLab token', async () => {
		const { engine, task } = await gitlabSetup(null);
		await expect(
			engine.publishTask({ taskId: task.id, title: 'x', body: '' })
		).rejects.toMatchObject({
			code: 'gitlab_token_missing'
		});
	});
});
