import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import {
	EngineError,
	type DataRecovery,
	type InstructionTemplate,
	type Repository,
	type ReviewAttribute,
	type Run
} from '#lib/engine/contract.js';

export interface StoredSettings {
	model: string;
	timeoutMinutes: number;
	concurrency: number;
	/** GitHub App client ID for "Sign in with GitHub" (public, not a secret). */
	githubClientId?: string | null;
	/** What reviews rate by default; unset means the built-in defaults. */
	reviewAttributes?: ReviewAttribute[];
}

export const defaultSettings: StoredSettings = {
	model: 'claude-opus-5-5',
	timeoutMinutes: 30,
	concurrency: 2
};

export interface StoreData {
	/** The shape of the data: the `to` of the last migration it went through, or 1. */
	version: number;
	repositories: Repository[];
	runs: Run[];
	settings: StoredSettings;
	templates: InstructionTemplate[];
}

const emptyData = (): StoreData => ({
	version: 1,
	repositories: [],
	runs: [],
	settings: { ...defaultSettings },
	templates: []
});

/**
 * One step in upgrading saved data, run once at start on data older than `to`. Add one, with
 * the next number, before changing the shape of anything saved; the change works on the data as
 * it was saved, so don't use the current types' guarantees in it.
 */
export interface Migration {
	/** The version the data has after this step; the first step is 2. */
	to: number;
	/** Change the data in place. */
	data?: (data: StoreData) => void;
	/** Change the tables, for what the data can't express (runs before `data`). */
	db?: (db: DatabaseSync) => void;
}

/** Every migration so far, in order. */
export const MIGRATIONS: Migration[] = [];

export type Collection = 'repositories' | 'runs' | 'templates';

/** Each list in the data is a table; new runs go first, everything else last. */
const COLLECTIONS: { name: Collection; newestFirst: boolean }[] = [
	{ name: 'repositories', newestFirst: false },
	{ name: 'runs', newestFirst: true },
	{ name: 'templates', newestFirst: false }
];

/** `PRAGMA quick_check` found damage. */
class CorruptData extends Error {}

/** SQLite's "database disk image is malformed" (11) and "file is not a database" (26). */
function isCorrupt(error: unknown) {
	if (error instanceof CorruptData) return true;
	const { code, errcode } = error as { code?: string; errcode?: number };
	return (
		code === 'ERR_SQLITE_ERROR' &&
		(((errcode ?? 0) & 0xff) === 11 || ((errcode ?? 0) & 0xff) === 26)
	);
}

function parseOrNull(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/** A row as it is on disk: its place in the list and its JSON. */
type SavedRow = { seq: number; json: string };

/**
 * The app's data in SQLite (`patchwork.db`): one row per repository, run and template, plus the
 * settings. Callers see the whole data in memory and change it in `update`; only the rows a
 * change touched are written, in one transaction, so a growing history doesn't make every
 * status change slower to save. Changes run one at a time, in order.
 */
export class Store {
	readonly file: string;
	private db: DatabaseSync | null = null;
	private data: StoreData | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private saved: Record<Collection, Map<string, SavedRow>> = {
		repositories: new Map(),
		runs: new Map(),
		templates: new Map()
	};
	private savedSettings = '';
	private savedVersion = 0;
	/** The version this app writes. */
	readonly version: number;
	/** Settles when the copy made at start is written (or failed). */
	backedUp: Promise<void> = Promise.resolve();
	/** Set when the saved data couldn't all be read at start, for the UI to tell the user. */
	recovery: DataRecovery | null = null;

	constructor(
		private readonly dataDir: string,
		private readonly migrations: Migration[] = MIGRATIONS
	) {
		this.file = path.join(dataDir, 'patchwork.db');
		migrations.forEach((m, i) => {
			if (m.to !== i + 2) throw new Error(`Migration ${i + 1} must go to version ${i + 2}.`);
		});
		this.version = migrations.at(-1)?.to ?? 1;
	}

	async read(): Promise<StoreData> {
		this.data ??= this.open();
		return this.data;
	}

	/**
	 * Apply a change to the data and save it. A change that calls `touch` for the rows it changed
	 * saves only those, without comparing the rest; it must change nothing else.
	 */
	update<T>(
		change: (data: StoreData, touch: (collection: Collection, id: string) => void) => T | Promise<T>
	): Promise<T> {
		const run = this.queue.then(async () => {
			const data = await this.read();
			const touched: { collection: Collection; id: string }[] = [];
			const result = await change(data, (collection, id) => touched.push({ collection, id }));
			if (touched.length > 0 && this.saveTouched(data, touched)) return result;
			this.save(data);
			return result;
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Close the database; the next `read` opens it again. */
	close() {
		this.closeDatabase();
		this.data = null;
	}

	private open(): StoreData {
		mkdirSync(this.dataDir, { recursive: true });
		try {
			const { data, existed } = this.load();
			if (existed) this.backUp();
			return data;
		} catch (error) {
			if (!isCorrupt(error)) throw error;
		}
		// The database is damaged: keep it aside, then use the backup, else start empty.
		const movedTo = this.moveAside(this.file);
		const backup = `${this.file}.bak`;
		if (existsSync(backup)) {
			copyFileSync(backup, this.file);
			try {
				const { data } = this.load();
				this.recovery = { kind: 'restored', movedTo, skipped: this.recovery?.skipped ?? 0 };
				return data;
			} catch (error) {
				if (!isCorrupt(error)) throw error;
				this.removeDatabase();
			}
		}
		const { data } = this.load();
		this.recovery = { kind: 'reset', movedTo, skipped: 0 };
		return data;
	}

	/** Open the database and read everything; `existed` is false for a new one. */
	private load(): { data: StoreData; existed: boolean } {
		this.closeDatabase();
		const db = new DatabaseSync(this.file);
		this.db = db;
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			${COLLECTIONS.map(
				({ name }) =>
					`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL);`
			).join('\n')}
		`);
		const check = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
		if (check.length !== 1 || check[0].quick_check !== 'ok') throw new CorruptData();

		const meta = db.prepare('SELECT value FROM meta WHERE key = ?');
		const saved = meta.get('version') as { value: string } | undefined;
		if (!saved) return { data: this.importJson(), existed: false };
		const version = Number(saved.value) || 1;
		this.refuseNewer(version);
		this.savedVersion = version;

		const data = emptyData();
		data.version = version;
		let skipped = 0;
		for (const { name, newestFirst } of COLLECTIONS) {
			const rows = db
				.prepare(`SELECT id, seq, data FROM ${name} ORDER BY seq ${newestFirst ? 'DESC' : 'ASC'}`)
				.all() as { id: string; seq: number; data: string }[];
			const items: unknown[] = [];
			for (const row of rows) {
				// An unreadable row stays in the database, untouched, and is left out here.
				const item = parseOrNull(row.data);
				if (item === null) {
					skipped++;
					continue;
				}
				this.saved[name].set(row.id, { seq: row.seq, json: row.data });
				items.push(item);
			}
			(data[name] as unknown[]) = items;
		}
		const settings = meta.get('settings') as { value: string } | undefined;
		if (settings) {
			this.savedSettings = settings.value;
			data.settings = { ...data.settings, ...(parseOrNull(settings.value) ?? {}) };
		}
		if (skipped > 0) this.recovery = { kind: 'partial', movedTo: null, skipped };
		this.migrate(data, true);
		return { data, existed: true };
	}

	/** Data from a newer Patchwork would be damaged by this one's changes. */
	private refuseNewer(version: number) {
		if (version > this.version) {
			throw new EngineError(
				'data_too_new',
				`This data was saved by a newer version of Patchwork (data version ${version}, this one knows ${this.version}). Update Patchwork to open it.`
			);
		}
	}

	/**
	 * Bring older data up to this version and save it, in one transaction. An existing database
	 * is copied first, as `patchwork.db.v<version>.bak`, in case a migration goes wrong.
	 */
	private migrate(data: StoreData, existed: boolean) {
		const steps = this.migrations.filter((m) => m.to > data.version);
		if (steps.length === 0) return;
		if (existed) {
			const copy = `${this.file}.v${data.version}.bak`;
			rmSync(copy, { force: true });
			this.db!.prepare('VACUUM INTO ?').run(copy);
		}
		const tables = steps.flatMap((m) => (m.db ? [() => m.db!(this.db!)] : []));
		for (const step of steps) {
			step.data?.(data);
			data.version = step.to;
		}
		this.save(data, tables);
	}

	/** A copy of the database as it was at start, to recover from if it's damaged later. */
	private backUp() {
		const target = `${this.file}.bak`;
		const partial = `${target}.partial`;
		this.backedUp = backup(this.db!, partial)
			.then(() => renameSync(partial, target))
			.catch(() => undefined);
	}

	/** Rename a damaged file (and SQLite's journal files next to it); returns the new name. */
	private moveAside(file: string) {
		this.closeDatabase();
		const target = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		renameSync(file, target);
		for (const suffix of ['-wal', '-shm']) {
			if (existsSync(file + suffix)) renameSync(file + suffix, target + suffix);
		}
		return target;
	}

	private removeDatabase() {
		this.closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) rmSync(this.file + suffix, { force: true });
	}

	private closeDatabase() {
		if (this.db?.isOpen) this.db.close();
		this.db = null;
		this.savedSettings = '';
		this.savedVersion = 0;
		for (const { name } of COLLECTIONS) this.saved[name].clear();
	}

	/**
	 * A new database: bring in `data.json` from before the database, if there is one, and keep it
	 * as `data.json.imported`.
	 */
	private importJson(): StoreData {
		const legacy = path.join(this.dataDir, 'data.json');
		const data = emptyData();
		let imported = false;
		try {
			const saved = JSON.parse(readFileSync(legacy, 'utf8')) as Partial<StoreData>;
			Object.assign(data, saved, {
				version: saved.version ?? 1,
				settings: { ...data.settings, ...saved.settings }
			});
			imported = true;
		} catch (error) {
			if (error instanceof SyntaxError) {
				this.recovery = { kind: 'reset', movedTo: this.moveJsonAside(legacy), skipped: 0 };
			} else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		this.refuseNewer(data.version);
		this.migrate(data, false);
		this.save(data);
		if (imported) renameSync(legacy, `${legacy}.imported`);
		return data;
	}

	private moveJsonAside(file: string) {
		const target = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		renameSync(file, target);
		return target;
	}

	/** Write just the touched rows; false when one isn't on disk yet, so everything is compared. */
	private saveTouched(data: StoreData, touched: { collection: Collection; id: string }[]) {
		const rows = touched.map(({ collection, id }) => ({
			collection,
			id,
			item: (data[collection] as { id: string }[]).find((item) => item.id === id),
			before: this.saved[collection].get(id)
		}));
		if (rows.some((row) => !row.item || !row.before)) return false;
		this.transaction(
			rows.map(({ collection, id, item, before }) => {
				const json = JSON.stringify(item);
				return () => {
					if (json === before!.json) return;
					this.db!.prepare(`UPDATE ${collection} SET data = ? WHERE id = ?`).run(json, id);
					this.saved[collection].set(id, { seq: before!.seq, json });
				};
			})
		);
		return true;
	}

	private transaction(writes: (() => void)[]) {
		const db = this.db!;
		db.exec('BEGIN');
		try {
			for (const write of writes) write();
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}

	/** Write the rows that differ from what's on disk, after `first` (in the same transaction). */
	private save(data: StoreData, first: (() => void)[] = []) {
		const db = this.db!;
		const writes: (() => void)[] = [...first];
		const after: (() => void)[] = [];

		for (const { name, newestFirst } of COLLECTIONS) {
			const saved = this.saved[name];
			const items = data[name] as { id: string }[];
			const seqs = this.placeOf(items, saved, newestFirst);
			const upsert = db.prepare(
				`INSERT INTO ${name} (id, seq, data) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, data = excluded.data`
			);
			const remove = db.prepare(`DELETE FROM ${name} WHERE id = ?`);
			const kept = new Set<string>();
			items.forEach((item, i) => {
				const row = { seq: seqs[i], json: JSON.stringify(item) };
				kept.add(item.id);
				const before = saved.get(item.id);
				if (before && before.seq === row.seq && before.json === row.json) return;
				writes.push(() => upsert.run(item.id, row.seq, row.json));
				after.push(() => saved.set(item.id, row));
			});
			for (const id of saved.keys()) {
				if (kept.has(id)) continue;
				writes.push(() => remove.run(id));
				after.push(() => saved.delete(id));
			}
		}
		const set = db.prepare(
			'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
		);
		const settings = JSON.stringify(data.settings);
		if (settings !== this.savedSettings) {
			writes.push(() => set.run('settings', settings));
			after.push(() => (this.savedSettings = settings));
		}
		if (data.version !== this.savedVersion) {
			const version = data.version;
			writes.push(() => set.run('version', String(version)));
			after.push(() => (this.savedVersion = version));
		}
		if (writes.length === 0) return;
		this.transaction(writes);
		for (const done of after) done();
	}

	/**
	 * Each item's `seq`, which orders the table like the list. New items get the next numbers;
	 * when the list was reordered, everything is numbered again.
	 */
	private placeOf(items: { id: string }[], saved: Map<string, SavedRow>, newestFirst: boolean) {
		let next = Math.max(0, ...[...saved.values()].map((row) => row.seq)) + 1;
		const fresh = new Map<string, number>();
		const order = newestFirst ? [...items].reverse() : items;
		for (const item of order) if (!saved.has(item.id)) fresh.set(item.id, next++);
		const seqs = items.map((item) => saved.get(item.id)?.seq ?? fresh.get(item.id)!);
		const ordered = seqs.every(
			(seq, i) => i === 0 || (newestFirst ? seq < seqs[i - 1] : seq > seqs[i - 1])
		);
		if (ordered) return seqs;
		return items.map((_, i) => (newestFirst ? items.length - i : i + 1));
	}
}
