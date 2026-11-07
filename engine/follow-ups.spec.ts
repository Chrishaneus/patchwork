import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import type { AgentRunInput, AgentRunner } from './agent';
import { createEngine, type Engine } from './index';
import { createRepo, run as git, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

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

/** Records every prompt and writes one numbered file per call. */
function recordingAgent() {
	const prompts: string[] = [];
	const agent: AgentRunner = async ({ cwd, instruction }: AgentRunInput) => {
		prompts.push(instruction);
		writeFileSync(path.join(cwd, `step-${prompts.length}.txt`), `step ${prompts.length}\n`);
		return { summary: `Summary after step ${prompts.length}.`, costUsd: 0.1, turns: 2 };
	};
	return { agent, prompts };
}

async function engineWithRepo(agent: AgentRunner, opts: { checkCommand?: string } = {}) {
	const engine = createEngine({
		dataDir: dirs.make('patchwork-data-'),
		runAgent: agent,
		pullRequestSyncMs: 0
	});
	const repoDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/widgets.git' });
	const repo = await engine.addRepository({ path: repoDir });
	if (opts.checkCommand)
		await engine.updateRepository({ id: repo.id, checkCommand: opts.checkCommand });
	const { tasks } = await engine.startRun({
		repositoryIds: [repo.id],
		instruction: 'Add step files'
	});
	const task = await waitFor(engine, tasks[0].id, ['awaiting_review']);
	return { engine, task, repo };
}

describe('follow-ups', () => {
	it('continues in the same working copy with the earlier context, and adds up cost', async () => {
		const { agent, prompts } = recordingAgent();
		const { engine, task } = await engineWithRepo(agent);

		const queued = await engine.followUpTask({
			taskId: task.id,
			instruction: 'Also add a second file'
		});
		expect(queued.status).toBe('queued');
		const done = await waitFor(engine, task.id, ['awaiting_review']);

		expect(prompts[1]).toContain('Add step files');
		expect(prompts[1]).toContain('Summary after step 1.');
		expect(prompts[1]).toContain('Also add a second file');
		expect(done).toMatchObject({
			worktreePath: task.worktreePath,
			baseCommit: task.baseCommit,
			branch: task.branch,
			summary: 'Summary after step 2.',
			costUsd: 0.2,
			turns: 4,
			diffStat: { files: 2 },
			followUps: [{ instruction: 'Also add a second file' }]
		});
		const log = await engine.getTaskLog({ taskId: task.id });
		expect(log.map((e) => e.text)).toContain('Follow-up: Also add a second file');
	});

	it('gives the agent the failing check output to fix', async () => {
		const { agent, prompts } = recordingAgent();
		// Passes once the agent has written step-2.txt.
		const { engine, task } = await engineWithRepo(agent, {
			checkCommand: 'test -f step-2.txt || (echo "missing step-2.txt" && exit 1)'
		});
		expect(task.checks?.status).toBe('failed');

		await engine.followUpTask({ taskId: task.id, instruction: 'Make the checks pass.' });
		const done = await waitFor(engine, task.id, ['awaiting_review']);

		expect(prompts[1]).toContain('missing step-2.txt');
		expect(prompts[1]).toContain('test -f step-2.txt');
		expect(done.checks?.status).toBe('passed');
	});

	it('works on failed tasks that kept their working copy, but not on published ones', async () => {
		let calls = 0;
		const flaky: AgentRunner = async ({ cwd }) => {
			calls += 1;
			if (calls === 1) throw new Error('model overloaded');
			writeFileSync(path.join(cwd, 'ok.txt'), 'ok\n');
			return { summary: 'Recovered.', costUsd: 0, turns: 1 };
		};
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			runAgent: flaky,
			pullRequestSyncMs: 0
		});
		// A plain bare remote: publishing pushes there, with no pull request.
		const bare = dirs.make('patchwork-remote-');
		git(bare, 'init', '-q', '--bare', '-b', 'main');
		const repoDir = createRepo(dirs.make(), { remote: bare });
		git(repoDir, 'push', '-q', 'origin', 'main');
		const repo = await engine.addRepository({ path: repoDir });
		const { tasks } = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		const failed = await waitFor(engine, tasks[0].id, ['failed']);

		await engine.followUpTask({ taskId: failed.id, instruction: 'Try again' });
		const recovered = await waitFor(engine, failed.id, ['awaiting_review']);
		expect(recovered).toMatchObject({ summary: 'Recovered.', error: null });

		expect((await engine.publishTask({ taskId: failed.id, title: 'x', body: '' })).status).toBe(
			'published'
		);
		await expect(
			engine.followUpTask({ taskId: failed.id, instruction: 'more' })
		).rejects.toMatchObject({
			code: 'invalid_state'
		});
		await expect(
			engine.followUpTask({ taskId: failed.id, instruction: ' ' })
		).rejects.toMatchObject({
			code: 'invalid_input'
		});
	});
});
