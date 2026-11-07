import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, Task } from '#lib/engine/contract.js';
import type { AgentRunner } from './agent';
import { createEngine, type Engine } from './index';
import { createRepo, run as git, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const agent: AgentRunner = async ({ cwd }) => {
	writeFileSync(path.join(cwd, 'x.txt'), 'x\n');
	return { summary: 'ok', costUsd: 0, turns: 1 };
};

/** A bare repository with one commit; its default branch is `branch`. */
function bareRepo(branch = 'main') {
	const bare = dirs.make('patchwork-bare-');
	git(bare, 'init', '-q', '--bare', '-b', branch);
	const seed = createRepo(dirs.make(), { remote: bare, branch });
	git(seed, 'push', '-q', 'origin', branch);
	return bare;
}

function waitForTask(engine: Engine, taskId: string, statuses: Task['status'][]) {
	return new Promise<Task>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status)) {
				stop();
				resolve(e.task);
			}
		});
	});
}

function setup() {
	const engine = createEngine({
		dataDir: dirs.make('patchwork-data-'),
		runAgent: agent,
		pullRequestSyncMs: 0
	});
	const events: EngineEvent[] = [];
	engine.subscribe((e) => events.push(e));
	return { engine, events };
}

describe('clone on demand', () => {
	it('registers without cloning, then clones when a change first runs', async () => {
		const { engine, events } = setup();
		const bare = bareRepo('trunk');

		const added = await engine.addRepositoryFromUrl({ url: `file://${bare}` });
		// The remote was checked (default branch found) but nothing was downloaded.
		expect(added).toMatchObject({ managed: true, cloneStatus: 'pending', defaultBranch: 'trunk' });
		expect(existsSync(added.path)).toBe(false);
		expect((await engine.listRepositories({}))[0].cloneStatus).toBe('pending');

		const { tasks } = await engine.startRun({ repositoryIds: [added.id], instruction: 'x' });
		const done = await waitForTask(engine, tasks[0].id, ['awaiting_review', 'failed']);

		expect(done).toMatchObject({ status: 'awaiting_review', baseBranch: 'trunk' });
		const log = (await engine.getTaskLog({ taskId: done.id })).map((e) => e.text);
		expect(log.some((t) => t.startsWith('Cloning file://'))).toBe(true);
		const [repo] = await engine.listRepositories({});
		expect(repo).toMatchObject({ cloneStatus: 'ready', status: { available: true } });
		expect(existsSync(path.join(repo.path, '.git'))).toBe(true);
		const updates = events
			.filter((e) => e.type === 'repository.updated')
			.map((e) => e.repository.cloneStatus);
		expect(updates).toEqual(['cloning', 'ready']);

		// A second run reuses the clone.
		const second = await engine.startRun({ repositoryIds: [repo.id], instruction: 'y' });
		await waitForTask(engine, second.tasks[0].id, ['awaiting_review']);
		const secondLog = (await engine.getTaskLog({ taskId: second.tasks[0].id })).map((e) => e.text);
		expect(secondLog.some((t) => t.startsWith('Cloning'))).toBe(false);
	});

	it('clones on request, and only once when asked twice at the same time', async () => {
		const { engine, events } = setup();
		const added = await engine.addRepositoryFromUrl({ url: `file://${bareRepo()}` });

		const [a, b] = await Promise.all([
			engine.cloneRepository({ id: added.id }),
			engine.cloneRepository({ id: added.id })
		]);

		expect(a).toMatchObject({
			cloneStatus: 'ready',
			status: { available: true, currentBranch: 'main' }
		});
		expect(b.cloneStatus).toBe('ready');
		expect(
			events.filter(
				(e) => e.type === 'repository.updated' && e.repository.cloneStatus === 'cloning'
			)
		).toHaveLength(1);
	});

	it('clones right away with clone: true', async () => {
		const { engine } = setup();
		const repo = await engine.addRepositoryFromUrl({ url: `file://${bareRepo()}`, clone: true });
		expect(repo.cloneStatus).toBe('ready');
		expect(existsSync(repo.path)).toBe(true);
	});

	it('fails the task when the clone fails, and a later attempt can succeed', async () => {
		const { engine } = setup();
		const bare = bareRepo();
		const added = await engine.addRepositoryFromUrl({ url: `file://${bare}` });
		// The remote disappears after it was added.
		rmSync(bare, { recursive: true, force: true });

		const { tasks } = await engine.startRun({ repositoryIds: [added.id], instruction: 'x' });
		const failed = await waitForTask(engine, tasks[0].id, ['failed', 'awaiting_review']);
		expect(failed).toMatchObject({ status: 'failed', error: { code: 'clone_failed' } });
		const [repo] = await engine.listRepositories({});
		expect(repo.cloneStatus).toBe('failed');
		expect(repo.cloneError).toContain('Could not clone');
		expect(existsSync(repo.path)).toBe(false);

		// The remote is back: cloning works again.
		git(path.dirname(bare), 'init', '-q', '--bare', '-b', 'main', bare);
		const seed = createRepo(dirs.make(), { remote: bare });
		git(seed, 'push', '-q', 'origin', 'main');
		expect((await engine.cloneRepository({ id: repo.id })).cloneStatus).toBe('ready');
	});

	it('refuses unreachable URLs when adding', async () => {
		const { engine } = setup();
		await expect(
			engine.addRepositoryFromUrl({ url: 'file:///nonexistent/repo.git' })
		).rejects.toMatchObject({
			code: 'clone_failed'
		});
		expect(await engine.listRepositories({})).toEqual([]);
	});
});
