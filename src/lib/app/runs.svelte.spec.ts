import { describe, expect, it } from 'vitest';
import { createEngineClient } from '#lib/engine/client.js';
import type { EngineEvent, EngineResult, Run, Task } from '#lib/engine/contract.js';
import { RunsState } from './runs.svelte';

const task = (status: Task['status']): Task => ({
	id: 't1',
	runId: 'r1',
	repositoryId: 'repo',
	repositoryName: 'widgets',
	status,
	branch: 'ai/x',
	baseBranch: 'main',
	baseCommit: null,
	worktreePath: null,
	startedAt: null,
	finishedAt: null,
	summary: null,
	error: null,
	costUsd: null,
	turns: null,
	diffStat: null,
	commitSha: null,
	pushedAt: null,
	pullRequest: null,
	publishError: null,
	checks: null,
	followUps: [],
	review: null,
	exploration: null
});

function setup() {
	const listeners = new Set<(e: EngineEvent) => void>();
	const run: Run = { id: 'r1', instruction: 'x', createdAt: '', tasks: [task('queued')] };
	const client = createEngineClient(async (method): Promise<EngineResult<unknown>> => {
		if (method === 'listRuns') return { ok: true, value: [run] };
		if (method === 'getTaskLog')
			return { ok: true, value: [{ at: '1', kind: 'info', text: 'first' }] };
		return { ok: false, error: { code: 'invalid_state', message: '' } };
	});
	const state = new RunsState(client, (l) => {
		listeners.add(l);
		return () => listeners.delete(l);
	});
	const emit = (e: EngineEvent) => listeners.forEach((l) => l(e));
	return { state, emit };
}

describe('RunsState', () => {
	it('applies live task updates and counts active tasks', async () => {
		const { state, emit } = setup();
		await state.load();
		expect(state.activeCount).toBe(1);

		emit({ type: 'task.updated', task: task('awaiting_review') });

		expect(state.run('r1')?.tasks[0].status).toBe('awaiting_review');
		expect(state.activeCount).toBe(0);
	});

	it('appends live log lines to an opened log', async () => {
		const { state, emit } = setup();
		await state.load();
		await state.loadLog('t1');

		emit({ type: 'task.log', taskId: 't1', entry: { at: '2', kind: 'tool', text: 'Edit a.ts' } });

		expect(state.logs.t1.map((e) => e.text)).toEqual(['first', 'Edit a.ts']);
	});

	it('keeps action errors per task', async () => {
		const { state } = setup();
		await state.load();
		await state.cancel('t1');
		expect(state.actionErrors.t1).toBe('invalid_state');
	});
});
