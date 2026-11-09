import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '#lib/engine/contract.js';
import { tempDirs } from '../test-helpers';
import { TaskLogs } from './logs';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const entry = (text: string): LogEntry => ({ at: new Date().toISOString(), kind: 'info', text });

describe('TaskLogs', () => {
	it('keeps entries in order and skips a line cut short', async () => {
		const dir = dirs.make('patchwork-logs-');
		const logs = new TaskLogs(dir);
		await Promise.all(['one', 'two', 'three'].map((text) => logs.append('t1', entry(text))));
		appendFileSync(path.join(dir, 't1.jsonl'), '{"at":"2026-');
		await logs.append('t1', entry('four'));

		const texts = (await logs.read('t1')).map((e) => e.text);
		expect(texts).toEqual(['one', 'two', 'three']);
		expect(await logs.read('missing')).toEqual([]);
	});

	it.skipIf(process.platform === 'win32')(
		'reports the first entry that can’t be saved, and says how many are missing',
		async () => {
			const dir = dirs.make('patchwork-logs-');
			const logs = new TaskLogs(dir);
			await logs.append('t1', entry('saved'));
			const file = path.join(dir, 't2.jsonl');
			writeFileSync(file, '');
			chmodSync(file, 0o444);
			const onFailure = vi.fn();
			await logs.append('t2', entry('lost 1'), onFailure);
			await logs.append('t2', entry('lost 2'), onFailure);
			expect(onFailure).toHaveBeenCalledOnce();

			const pending = await logs.read('t2');
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({ kind: 'error' });
			expect(pending[0].text).toMatch(/^2 entries .* missing here: EACCES/);

			chmodSync(file, 0o644);
			await logs.append('t2', entry('saved again'), onFailure);
			const texts = (await logs.read('t2')).map((e) => e.text);
			expect(texts).toHaveLength(2);
			expect(texts[0]).toContain('2 entries');
			expect(texts[1]).toBe('saved again');
			expect((await logs.read('t1')).map((e) => e.text)).toEqual(['saved']);
		}
	);
});
