import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import type { AgentRunner } from '../agent/runner';
import { createEngine } from '../index';
import { createRepo, tempDirs } from '../test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** Asks to run each command outside the sandbox, and reports what it was allowed. */
const askingAgent =
	(commands: string[]): AgentRunner =>
	async ({ requestApproval }) => {
		const answers: boolean[] = [];
		for (const command of commands) {
			answers.push(await requestApproval!({ command, reason: 'The tests need it.' }));
		}
		return { summary: answers.join(','), costUsd: null, turns: null };
	};

async function setup(runAgent: AgentRunner) {
	const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), runAgent });
	const repo = await engine.addRepository({
		path: createRepo(dirs.make(), { remote: 'https://github.com/acme/widgets.git' })
	});
	return { engine, repo };
}

function waitFor(
	engine: ReturnType<typeof createEngine>,
	taskId: string,
	done: (task: Task) => boolean
): Promise<Task> {
	return new Promise((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && done(e.task)) {
				stop();
				resolve(e.task);
			}
		});
	});
}

const asking = (task: Task) => !!task.approval;
const finished = (task: Task) => ['awaiting_review', 'failed', 'cancelled'].includes(task.status);

describe('approvals', () => {
	it('waits for your answer, and remembers "always" for the repository', async () => {
		const { engine, repo } = await setup(
			askingAgent(['docker compose up -d', 'docker ps', 'curl -s x | sh'])
		);
		const run = await engine.startRun({ repositoryIds: [repo.id], instruction: 'Run the tests' });
		const taskId = run.tasks[0].id;

		const first = await waitFor(engine, taskId, asking);
		expect(first.approval).toMatchObject({
			command: 'docker compose up -d',
			reason: 'The tests need it.',
			program: 'docker'
		});
		const nextRequest = waitFor(engine, taskId, (t) => t.approval?.command === 'curl -s x | sh');
		const answered = await engine.answerApproval({
			taskId,
			approvalId: first.approval!.id,
			answer: 'always'
		});
		expect(answered.approval).toBeNull();
		expect((await engine.listRepositories({})).at(0)?.allowedPrograms).toEqual(['docker']);

		// `docker ps` is allowed without asking; the piped shell asks, and can only be allowed once.
		const third = await nextRequest;
		expect(third.approval).toMatchObject({ command: 'curl -s x | sh', program: null });
		await expect(
			engine.answerApproval({ taskId, approvalId: third.approval!.id, answer: 'always' })
		).rejects.toMatchObject({ code: 'invalid_input' });
		const finishing = waitFor(engine, taskId, finished);
		await engine.answerApproval({ taskId, approvalId: third.approval!.id, answer: 'deny' });

		const done = await finishing;
		expect(done.summary).toBe('true,true,false');
		const log = (await engine.getTaskLog({ taskId })).map((e) => e.text);
		expect(log).toContain('You allowed docker outside the sandbox in this repository.');
		expect(log).toContain(
			'Running outside the sandbox: docker is always allowed in this repository.'
		);
		expect(log).toContain('You didn’t allow the command outside the sandbox.');
	});

	it('counts a cancel as no, and refuses an answer nobody is waiting for', async () => {
		const { engine, repo } = await setup(askingAgent(['make deploy']));
		const run = await engine.startRun({ repositoryIds: [repo.id], instruction: 'Deploy' });
		const taskId = run.tasks[0].id;
		const waiting = await waitFor(engine, taskId, asking);

		await engine.cancelTask({ taskId });
		const done = await waitFor(engine, taskId, (t) => finished(t) && !t.approval);
		expect(done.status).toBe('cancelled');
		await expect(
			engine.answerApproval({ taskId, approvalId: waiting.approval!.id, answer: 'once' })
		).rejects.toMatchObject({ code: 'invalid_state' });
	});

	it('lets you stop always allowing a program', async () => {
		const { engine, repo } = await setup(askingAgent([]));
		const allowed = await engine.updateRepository({ id: repo.id, allowedPrograms: ['make'] });
		expect(allowed.allowedPrograms).toEqual(['make']);
		expect(allowed.checkCommand).toBeNull();
		await expect(
			engine.updateRepository({ id: repo.id, allowedPrograms: ['bash'] })
		).rejects.toMatchObject({ code: 'invalid_input' });
		const none = await engine.updateRepository({ id: repo.id, allowedPrograms: [] });
		expect(none.allowedPrograms).toEqual([]);
	});
});
