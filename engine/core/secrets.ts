/**
 * Where the engine keeps secrets such as the Anthropic API key. Each host provides its own:
 * Electron encrypts them with the OS keychain (safeStorage); the server reads environment variables.
 */
export interface SecretStore {
	/** Whether saved secrets are encrypted at rest. */
	readonly encrypted: boolean;
	get(name: string): Promise<string | null>;
	/** Save a secret, or delete it with null. */
	set(name: string, value: string | null): Promise<void>;
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A JSON file of secrets, readable only by the owner. Saves write a temporary file and rename it
 * over the old one, one at a time, so a crash or two saves at once never lose keys. A file that
 * can't be parsed is set aside (the keys may still be recoverable from it) rather than
 * overwritten; other read errors are thrown, so nothing is saved over keys that couldn't be read.
 * Temporary and set-aside files go in `secretsFolder(file)`, which agents can't read either.
 */
/** Where a secrets file's temporary and set-aside copies go: `<file>.d`, next to it. */
export const secretsFolder = (file: string) => `${file}.d`;

export class SecretsFile {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly folder: string;

	constructor(readonly file: string) {
		this.folder = secretsFolder(file);
	}

	async read(): Promise<Record<string, string>> {
		let text: string;
		try {
			text = await readFile(this.file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
			throw error;
		}
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
		} catch {
			// Set aside below.
		}
		await mkdir(this.folder, { recursive: true, mode: 0o700 });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const aside = path.join(this.folder, `${path.basename(this.file)}.corrupt-${stamp}`);
		await rename(this.file, aside).catch(() => undefined);
		console.warn(`The secrets file couldn't be read; it was kept as ${aside}.`);
		return {};
	}

	/** Change the saved secrets and write them; changes run one at a time, in order. */
	update(change: (all: Record<string, string>) => void): Promise<void> {
		const run = this.queue.then(async () => {
			const all = await this.read();
			change(all);
			await mkdir(this.folder, { recursive: true, mode: 0o700 });
			const tmp = path.join(this.folder, `${path.basename(this.file)}.${process.pid}.tmp`);
			await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
			await rename(tmp, this.file);
		});
		this.queue = run.catch(() => undefined);
		return run;
	}
}

/** Keeps secrets in memory only; used in tests and as a safe default. */
export class MemorySecretStore implements SecretStore {
	readonly encrypted = true;
	private values = new Map<string, string>();

	async get(name: string) {
		return this.values.get(name) ?? null;
	}

	async set(name: string, value: string | null) {
		if (value === null) this.values.delete(name);
		else this.values.set(name, value);
	}
}

/**
 * Plain-text secrets in a file readable only by the owner. Used by the server, whose data folder
 * is a private volume; the Settings page tells the user the key isn't encrypted.
 */
export class FileSecretStore implements SecretStore {
	readonly encrypted = false;
	private readonly secrets: SecretsFile;

	constructor(file: string) {
		this.secrets = new SecretsFile(file);
	}

	async get(name: string) {
		return (await this.secrets.read())[name] ?? null;
	}

	async set(name: string, value: string | null) {
		await this.secrets.update((all) => {
			if (value === null) delete all[name];
			else all[name] = value;
		});
	}
}
