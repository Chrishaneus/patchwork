import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('Store recovery', () => {
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
		expect(check()).toBe(true);
	};
	const damage = (dir: string) => {
		const file = path.join(dir, 'patchwork.db');
		for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
		writeFileSync(file, 'not a database, just garbage '.repeat(200));
	};
	const asideIn = (dir: string, prefix: string) =>
		readdirSync(dir).filter(
			(name) => name.startsWith(`${prefix}.corrupt-`) && !/-(wal|shm)$/.test(name)
		);

	it('restores a damaged database from the copy made at the last start', async () => {
		const dir = dirs.make('patchwork-store-');
		const first = new Store(dir);
		await first.update((data) => data.runs.unshift(run('r1')));
		first.close();
		// The next start backs it up.
		const second = new Store(dir);
		await second.update((data) => data.runs.unshift(run('r2')));
		await until(() => existsSync(path.join(dir, 'patchwork.db.bak')));
		second.close();

		damage(dir);
		const store = new Store(dir);
		const data = await store.read();
		expect(data.runs.map((r) => r.id)).toEqual(['r1']);
		const [aside] = asideIn(dir, 'patchwork.db');
		expect(store.recovery).toEqual({
			kind: 'restored',
			movedTo: path.join(dir, aside),
			skipped: 0
		});
		await store.update((d) => d.runs.unshift(run('r3')));
		expect((await new Store(dir).read()).runs.map((r) => r.id)).toEqual(['r3', 'r1']);
	});

	it('starts empty when the database is damaged and there is no copy', async () => {
		const dir = dirs.make('patchwork-store-');
		const first = new Store(dir);
		await first.update((data) => data.runs.unshift(run('r1')));
		first.close();
		damage(dir);
		const store = new Store(dir);
		expect((await store.read()).runs).toEqual([]);
		expect(store.recovery).toMatchObject({ kind: 'reset' });
		expect(asideIn(dir, 'patchwork.db')).toHaveLength(1);
	});

	it('starts empty when data.json is damaged, keeping it aside', async () => {
		const dir = dirs.make('patchwork-store-');
		writeFileSync(path.join(dir, 'data.json'), '{"version":1,"runs":[');
		const store = new Store(dir);
		expect((await store.read()).runs).toEqual([]);
		expect(store.recovery).toMatchObject({ kind: 'reset' });
		const [aside] = asideIn(dir, 'data.json');
		expect(readFileSync(path.join(dir, aside), 'utf8')).toBe('{"version":1,"runs":[');
	});

	it('leaves out rows it can’t read, without deleting them', async () => {
		const dir = dirs.make('patchwork-store-');
		const first = new Store(dir);
		await first.update((data) => data.runs.unshift(run('r1'), run('r2')));
		first.close();
		const db = new DatabaseSync(path.join(dir, 'patchwork.db'));
		db.prepare("UPDATE runs SET data = '{broken' WHERE id = 'r2'").run();
		db.close();

		const store = new Store(dir);
		expect((await store.read()).runs.map((r) => r.id)).toEqual(['r1']);
		expect(store.recovery).toEqual({ kind: 'partial', movedTo: null, skipped: 1 });
		await store.update((data) => (data.runs[0].instruction = 'still saves'));
		store.close();
		const check = new DatabaseSync(path.join(dir, 'patchwork.db'));
		expect(check.prepare("SELECT data FROM runs WHERE id = 'r2'").get()).toEqual({
			data: '{broken'
		});
		check.close();
	});

	it('doesn’t move the data aside for errors that aren’t damage', async () => {
		const dir = dirs.make('patchwork-store-');
		mkdirSync(path.join(dir, 'patchwork.db'));
		await expect(new Store(dir).read()).rejects.toThrow();
		expect(asideIn(dir, 'patchwork.db')).toEqual([]);
	});
});
