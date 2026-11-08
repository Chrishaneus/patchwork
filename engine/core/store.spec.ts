import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstructionTemplate, Repository, Run } from '#lib/engine/contract.js';
import { tempDirs } from '../test-helpers';
import { Store, type Migration } from './store';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** Open the store in `dir` again, once its start-up copy is written. */
async function reopen(dir: string) {
	const store = new Store(dir);
	const data = await store.read();
	await store.backedUp;
	return data;
}

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

		const again = await reopen(dir);
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
		expect((await reopen(dir)).runs.map((r) => r.instruction)).toEqual(['touched', 'x']);
	});

	it('keeps a reordered list in its new order', async () => {
		const dir = dirs.make('patchwork-store-');
		const store = new Store(dir);
		await store.update((data) => data.templates.push(template('a'), template('b'), template('c')));
		await store.update((data) => data.templates.reverse());
		expect((await reopen(dir)).templates.map((t) => t.id)).toEqual(['c', 'b', 'a']);
	});

	it('brings in data.json from before the database, once', async () => {
		const dir = dirs.make('patchwork-store-');
		const legacy = path.join(dir, 'data.json');
		writeFileSync(
			legacy,
			JSON.stringify({ version: 1, repositories: [repo('a')], runs: [run('r1')], settings: {} })
		);
		const data = await reopen(dir);
		expect(data.repositories.map((r) => r.id)).toEqual(['a']);
		expect(data.templates).toEqual([]);
		expect(data.settings.concurrency).toBe(2);
		expect(existsSync(legacy)).toBe(false);
		expect(JSON.parse(readFileSync(`${legacy}.imported`, 'utf8')).runs).toHaveLength(1);
		expect((await reopen(dir)).runs.map((r) => r.id)).toEqual(['r1']);
	});
});

describe('Store recovery', () => {
	const damage = (dir: string) => {
		const file = path.join(dir, 'patchwork.db');
		for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
		writeFileSync(file, 'not a database, just garbage '.repeat(200));
	};

	it('restores a damaged database from the copy made at the last start', async () => {
		const dir = dirs.make('patchwork-store-');
		const first = new Store(dir);
		await first.update((data) => data.runs.unshift(run('r1')));
		first.close();
		// The next start backs it up.
		const second = new Store(dir);
		await second.update((data) => data.runs.unshift(run('r2')));
		await second.backedUp;
		expect(existsSync(path.join(dir, 'patchwork.db.bak'))).toBe(true);
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
		expect((await reopen(dir)).runs.map((r) => r.id)).toEqual(['r3', 'r1']);
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
		await store.backedUp;
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

describe('Store migrations', () => {
	const steps: Migration[] = [
		{
			to: 2,
			data: (data) => {
				for (const r of data.runs) (r as unknown as { title: string }).title = r.instruction;
			}
		},
		{
			to: 3,
			db: (db) => db.exec('CREATE TABLE extra (id TEXT)'),
			data: (data) => (data.settings.concurrency = 4)
		}
	];

	it('upgrades older data at start, once, after keeping a copy', async () => {
		const dir = dirs.make('patchwork-store-');
		const old = new Store(dir);
		await old.update((data) => data.runs.unshift(run('r1', 'Fix it')));
		await old.backedUp;
		old.close();

		const store = new Store(dir, steps);
		expect(store.version).toBe(3);
		const data = await store.read();
		await store.backedUp;
		expect(data.version).toBe(3);
		expect(data.runs[0]).toMatchObject({ title: 'Fix it' });
		expect(data.settings.concurrency).toBe(4);
		store.close();

		const db = new DatabaseSync(path.join(dir, 'patchwork.db'));
		expect(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
			value: '3'
		});
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeTruthy();
		db.close();
		const copy = new DatabaseSync(path.join(dir, 'patchwork.db.v1.bak'));
		expect(copy.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
			value: '1'
		});
		copy.close();

		// Already upgraded: the steps don't run again.
		const again = new Store(dir, [{ to: 2, data: () => expect.fail('ran twice') }, steps[1]]);
		expect((await again.read()).runs[0]).toMatchObject({ title: 'Fix it' });
		await again.backedUp;
	});

	it('upgrades data.json from before the database too', async () => {
		const dir = dirs.make('patchwork-store-');
		writeFileSync(
			path.join(dir, 'data.json'),
			JSON.stringify({ version: 1, repositories: [], runs: [run('r1', 'Old')] })
		);
		const data = await new Store(dir, steps).read();
		expect(data.runs[0]).toMatchObject({ title: 'Old' });
		expect(data.version).toBe(3);
	});

	it('refuses data saved by a newer version, without touching it', async () => {
		const dir = dirs.make('patchwork-store-');
		const newer = new Store(dir, steps);
		await newer.update((data) => data.runs.unshift(run('r1')));
		newer.close();
		await expect(new Store(dir).read()).rejects.toMatchObject({ code: 'data_too_new' });
		expect(asideIn(dir, 'patchwork.db')).toEqual([]);
		expect((await reopenWith(dir, steps)).runs.map((r) => r.id)).toEqual(['r1']);
	});

	it('needs the steps numbered in order', () => {
		expect(() => new Store('/nowhere', [{ to: 3 }])).toThrow(/version 2/);
	});
});

async function reopenWith(dir: string, migrations: Migration[]) {
	const store = new Store(dir, migrations);
	const data = await store.read();
	await store.backedUp;
	return data;
}

function asideIn(dir: string, prefix: string) {
	return readdirSync(dir).filter(
		(name) => name.startsWith(`${prefix}.corrupt-`) && !/-(wal|shm)$/.test(name)
	);
}
