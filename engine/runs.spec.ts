import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, Task } from '#lib/engine/contract.js';
import type { AgentRunner } from './agent';
import { createEngine } from './index';
import { createRepo, run as git, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** A fake agent that edits files like the real one would, without calling a model. */
const editingAgent: AgentRunner = async ({ cwd, log }) => {
	log({ kind: 'tool', text: 'Write hello.txt' });
	writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n');
	writeFileSync(path.join(cwd, 'README.md'), '# test\n\nMore docs.\n');
	return { summary: 'Added hello.txt and expanded the README.', costUsd: 0.01, turns: 3 };
};

/** Waits until it is cancelled. */
const hangingAgent: AgentRunner = ({ signal }) =>
	new Promise((_, reject) => {
		if (signal.aborted) reject(new Error('aborted'));
		signal.addEventListener('abort', () => reject(new Error('aborted')));
	});

async function setup(runAgent: AgentRunner) {
	const dataDir = dirs.make('patchwork-data-');
	const engine = createEngine({ dataDir, runAgent });
	const events: EngineEvent[] = [];
	engine.subscribe((e) => events.push(e));
	const repoDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/widgets.git' });
	const repo = await engine.addRepository({ path: repoDir });
	return { engine, events, repo, repoDir, dataDir };
}

function waitForStatus(
	engine: ReturnType<typeof createEngine>,
	taskId: string,
	statuses: Task['status'][]
): Promise<Task> {
	return new Promise((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status)) {
				stop();
				resolve(e.task);
			}
		});
	});
}

describe('runs', () => {
	it('runs the agent in an isolated worktree and reports the diff for review', async () => {
		const { engine, events, repo, repoDir } = await setup(editingAgent);
		writeFileSync(path.join(repoDir, 'mine.txt'), 'my uncommitted work');

		const run = await engine.startRun({
			repositoryIds: [repo.id],
			instruction: 'Add a hello file'
		});
		const [queued] = run.tasks;
		expect(queued.status).toBe('queued');
		expect(queued.branch).toMatch(/^ai\/add-a-hello-file-[0-9a-f]{6}$/);

		const done = await waitForStatus(engine, queued.id, ['awaiting_review', 'failed']);
		expect(done).toMatchObject({
			status: 'awaiting_review',
			summary: 'Added hello.txt and expanded the README.',
			costUsd: 0.01,
			diffStat: { files: 2, insertions: 3, deletions: 0 }
		});
		expect(events.filter((e) => e.type === 'task.updated').map((e) => e.task.status)).toEqual([
			'preparing',
			'preparing',
			'running',
			'running', // summary and cost saved as the agent finishes
			'awaiting_review'
		]);

		const diff = await engine.getTaskDiff({ taskId: queued.id });
		expect(diff.patch).toContain('+hello');
		expect(diff.patch).toContain('+More docs.');

		// The user's own checkout is untouched.
		expect(existsSync(path.join(repoDir, 'hello.txt'))).toBe(false);
		expect(git(repoDir, 'status', '--porcelain')).toBe('?? mine.txt');

		const log = await engine.getTaskLog({ taskId: queued.id });
		expect(log.map((e) => e.text)).toContain('Write hello.txt');
	});

	it('discards the worktree and branch', async () => {
		const { engine, repo, repoDir } = await setup(editingAgent);
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		const done = await waitForStatus(engine, tasks[0].id, ['awaiting_review']);

		const discarded = await engine.discardTask({ taskId: done.id });

		expect(discarded.status).toBe('discarded');
		expect(existsSync(done.worktreePath!)).toBe(false);
		expect(git(repoDir, 'branch', '--list', done.branch)).toBe('');
	});

	it('cancels a running task and keeps its partial work for review', async () => {
		const { engine, repo } = await setup(hangingAgent);
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		await waitForStatus(engine, tasks[0].id, ['running']);

		await engine.cancelTask({ taskId: tasks[0].id });
		const cancelled = await waitForStatus(engine, tasks[0].id, ['cancelled', 'failed']);

		expect(cancelled.status).toBe('cancelled');
		expect(cancelled.worktreePath && existsSync(cancelled.worktreePath)).toBe(true);
		await expect(engine.cancelTask({ taskId: tasks[0].id })).rejects.toMatchObject({
			code: 'invalid_state'
		});
	});

	it('records agent failures with their message', async () => {
		const failing: AgentRunner = async () => {
			throw new Error('model unavailable');
		};
		const { engine, repo } = await setup(failing);
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });

		const failed = await waitForStatus(engine, tasks[0].id, ['failed']);
		expect(failed.error).toEqual({ code: 'agent_failed', message: 'model unavailable' });
	});

	it('validates the request before starting', async () => {
		const { engine, repo, repoDir } = await setup(editingAgent);
		git(repoDir, 'branch', 'taken');

		await expect(
			engine.startRun({ repositoryIds: [repo.id], instruction: ' ' })
		).rejects.toMatchObject({
			code: 'invalid_input'
		});
		await expect(engine.startRun({ repositoryIds: [], instruction: 'x' })).rejects.toMatchObject({
			code: 'invalid_input'
		});
		await expect(
			engine.startRun({ repositoryIds: [repo.id], instruction: 'x', branch: 'bad..name' })
		).rejects.toMatchObject({ code: 'invalid_branch' });
		await expect(
			engine.startRun({ repositoryIds: [repo.id], instruction: 'x', branch: 'taken' })
		).rejects.toMatchObject({ code: 'invalid_branch' });
	});

	it('marks tasks that were running when the app closed as interrupted', async () => {
		const dataDir = dirs.make('patchwork-data-');
		mkdirSync(dataDir, { recursive: true });
		const task = { id: 't1', runId: 'r1', status: 'running' };
		writeFileSync(
			path.join(dataDir, 'data.json'),
			JSON.stringify({
				version: 1,
				repositories: [],
				runs: [{ id: 'r1', instruction: 'x', createdAt: '', tasks: [task] }]
			})
		);

		const engine = createEngine({ dataDir, runAgent: editingAgent });
		const [run] = await engine.listRuns({});

		expect(run.tasks[0]).toMatchObject({ status: 'failed', error: { code: 'interrupted' } });
	});
});

describe('settings', () => {
	it('saves the model, time limit and API key without ever returning the key', async () => {
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), runAgent: editingAgent });
		const before = await engine.getSettings({});
		expect(before.model).toBe('claude-opus-5-5');

		const after = await engine.updateSettings({
			model: 'claude-sonnet-5-5',
			timeoutMinutes: 10,
			concurrency: 2,
			anthropicApiKey: 'sk-test'
		});
		expect(after).toEqual({
			model: 'claude-sonnet-5-5',
			timeoutMinutes: 10,
			concurrency: 2,
			anthropicApiKey: { source: 'saved', encrypted: true },
			githubToken: expect.objectContaining({ encrypted: true }),
			gitlabToken: expect.objectContaining({ encrypted: true }),
			githubClientId: { value: null, source: null },
			githubAccount: null,
			reviewAttributes: expect.any(Array)
		});
		expect(JSON.stringify(after)).not.toContain('sk-test');

		await expect(engine.updateSettings({ timeoutMinutes: 0 })).rejects.toMatchObject({
			code: 'invalid_input'
		});
	});
});
