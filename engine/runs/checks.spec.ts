import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import type { AgentRunner } from '../agent/runner';
import { createEngine, type Engine } from '../index';
import { createRepo, tempDirs } from '../test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const editingAgent: AgentRunner = async ({ cwd }) => {
	writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
	return { summary: 'Done.', costUsd: 0, turns: 1 };
};

/** Never finishes until cancelled. */
const hangingAgent: AgentRunner = ({ signal }) =>
	new Promise((_, reject) => {
		if (signal.aborted) reject(new Error('aborted'));
		signal.addEventListener('abort', () => reject(new Error('aborted')));
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

async function setup(checkCommand: string | null, agent: AgentRunner = editingAgent) {
	const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), runAgent: agent });
	const repoDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/widgets.git' });
	const repo = await engine.addRepository({ path: repoDir });
	expect(repo.checkCommand).toBeNull();
	if (checkCommand !== null) await engine.updateRepository({ id: repo.id, checkCommand });
	return { engine, repo };
}

async function runOnce(engine: Engine, repoId: string) {
	const { tasks } = await engine.startRun({ repositoryIds: [repoId], instruction: 'x' });
	return waitFor(engine, tasks[0].id, ['awaiting_review', 'failed', 'cancelled']);
}

describe('checks', () => {
	it('runs the check command in the worktree after the agent and records a pass', async () => {
		const { engine, repo } = await setup('test -f feature.txt && echo all good');
		const task = await runOnce(engine, repo.id);

		expect(task.status).toBe('awaiting_review');
		expect(task.checks).toMatchObject({ status: 'passed', exitCode: 0, output: 'all good' });
		const log = await engine.getTaskLog({ taskId: task.id });
		expect(log.map((e) => e.text)).toEqual(
			expect.arrayContaining(['$ test -f feature.txt && echo all good', 'Checks passed.'])
		);
	});

	it('records a failure with its output and keeps the task in review', async () => {
		const { engine, repo } = await setup('echo "1 test failed" >&2; exit 3');
		const task = await runOnce(engine, repo.id);

		expect(task.status).toBe('awaiting_review');
		expect(task.checks).toMatchObject({ status: 'failed', exitCode: 3, output: '1 test failed' });
	});

	it('skips checks when the repository has none', async () => {
		const { engine, repo } = await setup(null);
		expect((await runOnce(engine, repo.id)).checks).toBeNull();
	});

	it("doesn't pass the app's secrets to the check command", async () => {
		process.env.GITHUB_TOKEN = 'secret-github';
		process.env.ANTHROPIC_API_KEY = 'secret-anthropic';
		try {
			const { engine, repo } = await setup('echo "[$GITHUB_TOKEN$ANTHROPIC_API_KEY]"');
			expect((await runOnce(engine, repo.id)).checks?.output).toBe('[]');
		} finally {
			delete process.env.GITHUB_TOKEN;
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it('stops a long-running check when the task is cancelled', async () => {
		const { engine, repo } = await setup('sleep 30');
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		await waitFor(engine, tasks[0].id, ['checking']);

		const started = Date.now();
		await engine.cancelTask({ taskId: tasks[0].id });
		const task = await waitFor(engine, tasks[0].id, ['cancelled']);

		expect(Date.now() - started).toBeLessThan(5000);
		expect(task.checks?.status).toBe('failed');
	});

	it('runs checks again on request, e.g. after changing the command', async () => {
		const { engine, repo } = await setup('exit 1');
		const task = await runOnce(engine, repo.id);
		expect(task.checks?.status).toBe('failed');

		await engine.updateRepository({ id: repo.id, checkCommand: 'echo fixed' });
		const rechecked = await engine.runChecks({ taskId: task.id });

		expect(rechecked.status).toBe('awaiting_review');
		expect(rechecked.checks).toMatchObject({ status: 'passed', command: 'echo fixed' });
	});

	it('turns checks off with an empty command', async () => {
		const { engine, repo } = await setup('echo hi');
		const updated = await engine.updateRepository({ id: repo.id, checkCommand: '  ' });
		expect(updated.checkCommand).toBeNull();
	});
});

describe('concurrency', () => {
	it('runs at most the configured number of tasks at once, and picks up a raised limit', async () => {
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), runAgent: hangingAgent });
		await engine.updateSettings({ concurrency: 1 });
		const ids = [];
		for (const name of ['a', 'b', 'c']) {
			const dir = createRepo(dirs.make(), { remote: `https://github.com/acme/${name}.git` });
			ids.push((await engine.addRepository({ path: dir })).id);
		}

		const run = await engine.startRun({ repositoryIds: ids, instruction: 'x' });
		await waitFor(engine, run.tasks[0].id, ['running']);
		await new Promise((r) => setTimeout(r, 300));
		const statuses = async () => (await engine.getRun({ id: run.id })).tasks.map((t) => t.status);
		expect(await statuses()).toEqual(['running', 'queued', 'queued']);

		await engine.updateSettings({ concurrency: 3 });
		await Promise.all(run.tasks.slice(1).map((t) => waitFor(engine, t.id, ['running'])));
		expect(await statuses()).toEqual(['running', 'running', 'running']);

		for (const t of run.tasks) await engine.cancelTask({ taskId: t.id });
		await Promise.all(run.tasks.map((t) => waitFor(engine, t.id, ['cancelled'])));
	});

	it('validates the setting', async () => {
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), runAgent: editingAgent });
		expect((await engine.getSettings({})).concurrency).toBe(2);
		await expect(engine.updateSettings({ concurrency: 0 })).rejects.toMatchObject({
			code: 'invalid_input'
		});
		await expect(engine.updateSettings({ concurrency: 9 })).rejects.toMatchObject({
			code: 'invalid_input'
		});
	});
});
