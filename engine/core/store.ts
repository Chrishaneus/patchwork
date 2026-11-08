import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	InstructionTemplate,
	Repository,
	ReviewAttribute,
	Run
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
	version: 1;
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

export type Collection = 'repositories' | 'runs' | 'templates';

/** Each list in the data is a table; new runs go first, everything else last. */
const COLLECTIONS: { name: Collection; newestFirst: boolean }[] = [
	{ name: 'repositories', newestFirst: false },
	{ name: 'runs', newestFirst: true },
	{ name: 'templates', newestFirst: false }
];

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

	constructor(private readonly dataDir: string) {
		this.file = path.join(dataDir, 'patchwork.db');
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

	private open(): StoreData {
		mkdirSync(this.dataDir, { recursive: true });
		const db = new DatabaseSync(this.file);
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			${COLLECTIONS.map(
				({ name }) =>
					`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL);`
			).join('\n')}
		`);
		this.db = db;

		const meta = db.prepare('SELECT value FROM meta WHERE key = ?');
		if (!meta.get('version')) return this.importJson();

		const data = emptyData();
		for (const { name, newestFirst } of COLLECTIONS) {
			const rows = db
				.prepare(`SELECT id, seq, data FROM ${name} ORDER BY seq ${newestFirst ? 'DESC' : 'ASC'}`)
				.all() as { id: string; seq: number; data: string }[];
			for (const row of rows) this.saved[name].set(row.id, { seq: row.seq, json: row.data });
			(data[name] as unknown[]) = rows.map((row) => JSON.parse(row.data));
		}
		const settings = meta.get('settings') as { value: string } | undefined;
		if (settings) {
			this.savedSettings = settings.value;
			data.settings = { ...data.settings, ...JSON.parse(settings.value) };
		}
		return data;
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
			Object.assign(data, saved, { settings: { ...data.settings, ...saved.settings } });
			imported = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		this.save(data);
		if (imported) renameSync(legacy, `${legacy}.imported`);
		return data;
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

	/** Write the rows that differ from what's on disk. */
	private save(data: StoreData) {
		const db = this.db!;
		const writes: (() => void)[] = [];
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
		const settings = JSON.stringify(data.settings);
		if (settings !== this.savedSettings) {
			const set = db.prepare(
				'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
			);
			writes.push(() => {
				set.run('version', String(data.version));
				set.run('settings', settings);
			});
			after.push(() => (this.savedSettings = settings));
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
