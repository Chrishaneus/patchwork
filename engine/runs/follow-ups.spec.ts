import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import type { AgentRunInput, AgentRunner } from '../agent/runner';
import { createEngine, type Engine } from '../index';
import { createRepo, run as git, tempDirs } from '../test-helpers';

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

	it('turns a question into a change in the same conversation, keeping what was said', async () => {
		const calls: AgentRunInput[] = [];
		let answers = 0;
		const {
			engine,
			task: change,
			repo
		} = await engineWithRepo(async (input) => {
			calls.push(input);
			if (input.mode === 'ask') return { summary: `Answer ${++answers}.`, costUsd: 0.1, turns: 1 };
			writeFileSync(path.join(input.cwd, 'cache.txt'), 'cache\n');
			return { summary: 'Added a cache.', costUsd: 0.5, turns: 3 };
		});
		const run = await engine.startAsk({ repositoryIds: [repo.id], question: 'Is there a cache?' });
		const asked = await waitFor(engine, run.tasks[0].id, ['completed']);
		await engine.followUpTask({ taskId: asked.id, instruction: 'Where would one go?' });
		await waitFor(engine, asked.id, ['completed']);

		const events: string[] = [];
		engine.subscribe((e) => {
			if (e.type === 'run.updated') events.push(e.run.kind ?? '');
		});
		const switched = await engine.switchToChange({ runId: run.id, instruction: 'Add one' });
		expect(switched).toMatchObject({ kind: 'code', switchedFrom: { kind: 'ask' } });
		expect(switched.tasks[0]).toMatchObject({
			status: 'queued',
			branch: expect.stringMatching(/^ai\/add-one-/)
		});
		expect(events).toEqual(['code']);
		const done = await waitFor(engine, asked.id, ['awaiting_review', 'failed']);

		const prompt = calls.at(-1)!;
		expect(prompt.mode).toBeUndefined();
		expect(prompt.instruction).toContain('Is there a cache?');
		expect(prompt.instruction).toContain('- Where would one go?');
		expect(prompt.instruction).toContain('Your latest answer was:\n\nAnswer 2.');
		expect(prompt.instruction).toContain('you can edit files now:\n\nAdd one');
		expect(done).toMatchObject({
			status: 'awaiting_review',
			summary: 'Added a cache.',
			diffStat: { files: 1 },
			costUsd: 0.7,
			turns: 5,
			followUps: [{ instruction: 'Where would one go?' }, { instruction: 'Add one' }]
		});
		expect(git(repo.path, 'branch', '--list', done.branch)).toContain(done.branch);
		const log = await engine.getTaskLog({ taskId: asked.id });
		expect(log.map((e) => e.text)).toContain(`Switching to a change on the branch ${done.branch}.`);

		// Changes keep working as changes: follow-ups continue in the new working copy.
		await engine.followUpTask({ taskId: done.id, instruction: 'Also document it' });
		expect(await waitFor(engine, done.id, ['awaiting_review'])).toMatchObject({
			worktreePath: done.worktreePath
		});

		await expect(
			engine.switchToChange({ runId: run.id, instruction: 'again' })
		).rejects.toMatchObject({ code: 'invalid_state' });
		await expect(
			engine.switchToChange({ runId: change.runId, instruction: 'x' })
		).rejects.toMatchObject({ code: 'invalid_state' });
		await expect(engine.switchToChange({ runId: 'nope', instruction: 'x' })).rejects.toMatchObject({
			code: 'run_not_found'
		});
	});

	it('turns an exploration into a change with what it found, only once it has finished', async () => {
		const prompts: string[] = [];
		const { engine, repo } = await engineWithRepo(async (input) => {
			prompts.push(input.instruction);
			if (input.mode === 'explore') {
				await new Promise((r) => setTimeout(r, 50));
				return {
					summary:
						'```json\n{"approaches":[{"title":"Memory cache","summary":"An in-memory map.","effort":"small","files":[],"pros":[],"cons":[]}],"recommendation":"Memory cache."}\n```',
					costUsd: 0,
					turns: 1
				};
			}
			return { summary: 'Done.', costUsd: 0, turns: 1 };
		});
		const run = await engine.startExplore({ repositoryIds: [repo.id], idea: 'Caching' });
		await expect(
			engine.switchToChange({ runId: run.id, instruction: 'Build it' })
		).rejects.toMatchObject({ code: 'invalid_state' });
		await waitFor(engine, run.tasks[0].id, ['completed']);
		await expect(engine.switchToChange({ runId: run.id, instruction: ' ' })).rejects.toMatchObject({
			code: 'invalid_input'
		});

		await engine.switchToChange({ runId: run.id, instruction: 'Build the memory cache' });
		const done = await waitFor(engine, run.tasks[0].id, ['awaiting_review', 'failed']);
		expect(done.status).toBe('awaiting_review');
		expect(done.exploration?.approaches[0].title).toBe('Memory cache');
		expect(prompts.at(-1)).toContain('Earlier you explored this idea');
		expect(prompts.at(-1)).toContain('"title": "Memory cache"');
		expect(prompts.at(-1)).toContain('Build the memory cache');
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
