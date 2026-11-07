import { describe, expect, it } from 'vitest';
import type { Run, Task } from '#lib/engine/contract.js';
import { matchesFilter, matchesSearch } from './run-filter';

const task = (status: Task['status'], extra: Partial<Task> = {}) =>
	({ status, repositoryName: 'widgets', branch: 'ai/x', followUps: [], ...extra }) as Task;
const run = (instruction: string, tasks: Task[]) =>
	({ id: '1', instruction, createdAt: '', tasks }) as Run;

describe('run filters', () => {
	it('matches runs where any task has the status', () => {
		const mixed = run('x', [task('published'), task('failed')]);
		expect(matchesFilter(mixed, 'published')).toBe(true);
		expect(matchesFilter(mixed, 'failed')).toBe(true);
		expect(matchesFilter(mixed, 'review')).toBe(false);
		expect(matchesFilter(run('x', [task('checking')]), 'active')).toBe(true);
		expect(matchesFilter(mixed, 'all')).toBe(true);
	});

	it('searches instructions, repositories, branches and follow-ups', () => {
		const r = run('Upgrade ESLint', [
			task('awaiting_review', { followUps: [{ instruction: 'Fix the README', at: '' }] })
		]);
		expect(matchesSearch(r, 'eslint')).toBe(true);
		expect(matchesSearch(r, 'WIDGETS')).toBe(true);
		expect(matchesSearch(r, 'ai/x')).toBe(true);
		expect(matchesSearch(r, 'readme')).toBe(true);
		expect(matchesSearch(r, 'billing')).toBe(false);
		expect(matchesSearch(r, '  ')).toBe(true);
	});
});
