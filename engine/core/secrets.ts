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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

	constructor(private readonly file: string) {}

	private async readAll(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await readFile(this.file, 'utf8'));
		} catch {
			return {};
		}
	}

	async get(name: string) {
		return (await this.readAll())[name] ?? null;
	}

	async set(name: string, value: string | null) {
		const all = await this.readAll();
		if (value === null) delete all[name];
		else all[name] = value;
		await mkdir(path.dirname(this.file), { recursive: true });
		await writeFile(this.file, JSON.stringify(all), { mode: 0o600 });
	}
}
