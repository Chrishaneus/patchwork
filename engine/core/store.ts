import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/**
 * A small JSON-file store. Writes are serialized and atomic (write to a temp file, then rename),
 * so a crash never leaves a half-written file. Swap for SQLite once queries are needed.
 */
export class JsonStore {
	readonly file: string;
	private data: StoreData | null = null;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		this.file = path.join(dataDir, 'data.json');
	}

	async read(): Promise<StoreData> {
		if (!this.data) {
			try {
				const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoreData>;
				const base = emptyData();
				this.data = { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				this.data = emptyData();
			}
		}
		return this.data!;
	}

	/** Apply a change to the data and persist it. Changes run one at a time, in order. */
	update<T>(change: (data: StoreData) => T | Promise<T>): Promise<T> {
		const run = this.queue.then(async () => {
			const data = await this.read();
			const result = await change(data);
			await mkdir(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			await writeFile(tmp, JSON.stringify(data, null, '\t'));
			await rename(tmp, this.file);
			return result;
		});
		this.queue = run.catch(() => undefined);
		return run;
	}
}
