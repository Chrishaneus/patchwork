import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstructionTemplate, Repository, Run } from '#lib/engine/contract.js';
import { tempDirs } from '../test-helpers';
import { Store } from './store';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const run = (id: string, instruction = 'x') => ({ id, instruction, tasks: [] }) as unknown as Run;
const repo = (id: string) => ({ id, name: id }) as unknown as Repository;
const template = (id: string) => ({ id, name: id }) as unknown as InstructionTemplate;

describe('Store', () => {
	it('saves changes and reads them back in order after a restart', async () => {
		const dir = dirs.make('patchwork-store-');
		const store = new Store(dir);
		await store.update((data) => {
			data.repositories.push(repo('a'), repo('b'));
			data.templates.push(template('t1'));
			data.settings.model = 'gpt-6-luna';
		});
		for (const id of ['r1', 'r2', 'r3']) await store.update((data) => data.runs.unshift(run(id)));
		await store.update((data) => {
			data.runs.find((r) => r.id === 'r2')!.instruction = 'changed';
			data.repositories = data.repositories.filter((r) => r.id !== 'a');
		});

		const again = await new Store(dir).read();
		expect(again.runs.map((r) => [r.id, r.instruction])).toEqual([
			['r3', 'x'],
			['r2', 'changed'],
			['r1', 'x']
		]);
		expect(again.repositories.map((r) => r.id)).toEqual(['b']);
		expect(again.templates.map((t) => t.id)).toEqual(['t1']);
		expect(again.settings).toMatchObject({ model: 'gpt-6-luna', timeoutMinutes: 30 });
	});

	it('writes only the rows a change touched', async () => {
		const dir = dirs.make('patchwork-store-');
		const store = new Store(dir);
		await store.update((data) => data.runs.unshift(run('r1'), run('r2')));
		const db = new DatabaseSync(path.join(dir, 'patchwork.db'));
		db.exec('CREATE TABLE writes (id TEXT)');
		db.exec(
			'CREATE TRIGGER counted AFTER UPDATE ON runs BEGIN INSERT INTO writes VALUES (new.id); END'
		);
		await store.update((data) => (data.runs[1].instruction = 'changed'));
		expect(db.prepare('SELECT id FROM writes').all()).toEqual([{ id: 'r2' }]);
		db.close();
	});

	it('saves only the touched rows when a change names them', async () => {
		const dir = dirs.make('patchwork-store-');
		const store = new Store(dir);
		await store.update((data) => data.runs.unshift(run('r1'), run('r2')));
		await store.update((data, touch) => {
			data.runs[0].instruction = 'touched';
			touch('runs', 'r1');
		});
		expect((await new Store(dir).read()).runs.map((r) => r.instruction)).toEqual(['touched', 'x']);
	});

	it('keeps a reordered list in its new order', async () => {
		const dir = dirs.make('patchwork-store-');
		const store = new Store(dir);
		await store.update((data) => data.templates.push(template('a'), template('b'), template('c')));
		await store.update((data) => data.templates.reverse());
		expect((await new Store(dir).read()).templates.map((t) => t.id)).toEqual(['c', 'b', 'a']);
	});

	it('brings in data.json from before the database, once', async () => {
		const dir = dirs.make('patchwork-store-');
		const legacy = path.join(dir, 'data.json');
		writeFileSync(
			legacy,
			JSON.stringify({ version: 1, repositories: [repo('a')], runs: [run('r1')], settings: {} })
		);
		const data = await new Store(dir).read();
		expect(data.repositories.map((r) => r.id)).toEqual(['a']);
		expect(data.templates).toEqual([]);
		expect(data.settings.concurrency).toBe(2);
		expect(existsSync(legacy)).toBe(false);
		expect(JSON.parse(readFileSync(`${legacy}.imported`, 'utf8')).runs).toHaveLength(1);
		expect((await new Store(dir).read()).runs.map((r) => r.id)).toEqual(['r1']);
	});
});
