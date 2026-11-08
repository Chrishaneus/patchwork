import { describe, expect, it } from 'vitest';
import type { LogEntry, Run, Task } from '#lib/engine/contract.js';
import { buildThread } from './agent-thread';

const t = (seconds: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, seconds)).toISOString();
const task = (id: string, name: string, followUps: Task['followUps'] = []) =>
	({ id, repositoryName: name, followUps }) as Task;
const entry = (seconds: number, kind: LogEntry['kind'], text: string): LogEntry => ({
	at: t(seconds),
	kind,
	text
});

describe('buildThread', () => {
	const run = {
		id: 'r',
		instruction: 'Add a changelog',
		createdAt: t(0),
		tasks: [
			task('a', 'api', [{ instruction: 'Also update the README', at: t(30) }]),
			task('b', 'web', [{ instruction: 'Also update the README', at: t(31) }])
		]
	} as Run;
	const logs = {
		a: [
			entry(1, 'info', 'Fetching origin/main…'),
			entry(5, 'assistant', 'Done in api.'),
			entry(30, 'info', 'Follow-up: Also update the README'),
			entry(35, 'tool', 'Edit README.md')
		],
		b: [entry(6, 'assistant', 'Done in web.'), entry(40, 'result', 'Updated the README.')]
	};

	it('merges messages and agent output in time order, one message for a follow-up sent to all', () => {
		const thread = buildThread(run, logs);
		expect(thread.map((i) => [i.kind, i.text, i.repos.join(',')])).toEqual([
			['user', 'Add a changelog', 'api,web'],
			['info', 'Fetching origin/main…', 'api'],
			['assistant', 'Done in api.', 'api'],
			['assistant', 'Done in web.', 'web'],
			['user', 'Also update the README', 'api,web'],
			['tool', 'Edit README.md', 'api'],
			['assistant', 'Updated the README.', 'web']
		]);
	});

	it('shows one repository on its own', () => {
		const thread = buildThread(run, logs, 'b');
		expect(thread.map((i) => i.text)).toEqual([
			'Add a changelog',
			'Done in web.',
			'Also update the README',
			'Updated the README.'
		]);
		expect(thread.every((i) => i.repos.join() === 'web')).toBe(true);
	});

	it('shows what the agent says while still working as notes, and only the last as its reply', () => {
		const working = (status: Task['status']) =>
			({
				id: 'r4',
				instruction: 'Run the tests',
				createdAt: t(0),
				tasks: [{ ...task('a', 'api', [{ instruction: 'Again', at: t(30) }]), status }]
			}) as Run;
		const log = {
			a: [
				entry(1, 'assistant', 'Installing first.'),
				entry(2, 'tool', '$ npm ci'),
				entry(10, 'assistant', 'Still installing…'),
				entry(20, 'assistant', 'All tests pass.'),
				entry(31, 'tool', '$ npm test'),
				entry(40, 'assistant', 'Still green.')
			]
		};
		const kinds = (status: Task['status']) =>
			buildThread(working(status), log)
				.filter((i) => i.kind !== 'user')
				.map((i) => [i.kind, i.text]);
		expect(kinds('awaiting_review')).toEqual([
			['note', 'Installing first.'],
			['tool', '$ npm ci'],
			['note', 'Still installing…'],
			['assistant', 'All tests pass.'],
			['tool', '$ npm test'],
			['assistant', 'Still green.']
		]);
		expect(kinds('running').at(-1)).toEqual(['note', 'Still green.']);
	});

	it('shows a review as a report card instead of its JSON', () => {
		const review = { scores: [], summary: 'ok', verdict: 'comment', postedUrl: null } as const;
		const reviewRun = {
			id: 'r2',
			kind: 'review',
			instruction: 'https://github.com/acme/api/pull/3',
			createdAt: t(0),
			tasks: [{ ...task('a', 'api'), review, exploration: null, finishedAt: t(20) }]
		} as unknown as Run;
		const thread = buildThread(reviewRun, {
			a: [
				entry(10, 'assistant', 'Looked at the diff.'),
				entry(19, 'result', 'All good.\n\n```json\n{"scores": []}\n```'),
				entry(19, 'result', '```json\n{}\n```')
			]
		});
		expect(thread.map((i) => [i.kind, i.text])).toEqual([
			['user', 'https://github.com/acme/api/pull/3'],
			['note', 'Looked at the diff.'],
			['assistant', 'All good.'],
			['report', '']
		]);
		expect(thread.at(-1)!.taskId).toBe('a');
	});

	it('keeps an exploration that became a change where it was, and its JSON hidden', () => {
		const exploration = { approaches: [], recommendation: 'Use a map.' };
		const switched = {
			id: 'r3',
			kind: 'code',
			switchedFrom: { kind: 'explore', at: t(30) },
			instruction: 'Caching',
			createdAt: t(0),
			tasks: [
				{
					...task('a', 'api', [{ instruction: 'Build it', at: t(30) }]),
					review: null,
					exploration,
					finishedAt: t(60)
				}
			]
		} as unknown as Run;
		const thread = buildThread(switched, {
			a: [
				entry(10, 'result', 'Two options.\n\n```json\n{}\n```'),
				entry(31, 'info', 'Switching to a change on the branch ai/build-it-a.'),
				entry(59, 'result', 'Added the cache.\n\n```json\n{"kept": true}\n```')
			]
		});
		expect(thread.map((i) => [i.kind, i.text])).toEqual([
			['user', 'Caching'],
			['assistant', 'Two options.'],
			['report', ''],
			['user', 'Build it'],
			['info', 'Switching to a change on the branch ai/build-it-a.'],
			['assistant', 'Added the cache.\n\n```json\n{"kept": true}\n```']
		]);
	});
});
