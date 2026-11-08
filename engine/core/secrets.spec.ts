import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../test-helpers';
import { FileSecretStore } from './secrets';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('FileSecretStore', () => {
	it('saves secrets owner-only, through a temporary file', async () => {
		const dir = dirs.make('patchwork-secrets-');
		const file = path.join(dir, 'secrets.json');
		const store = new FileSecretStore(file);
		await store.set('githubToken', 'ghp_1');
		await store.set('openaiApiKey', 'sk-1');
		await store.set('githubToken', null);

		expect(await new FileSecretStore(file).get('openaiApiKey')).toBe('sk-1');
		expect(await store.get('githubToken')).toBeNull();
		expect(readdirSync(dir).sort()).toEqual(['secrets.json', 'secrets.json.d']);
		expect(readdirSync(path.join(dir, 'secrets.json.d'))).toEqual([]);
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it('keeps every key when several are saved at once', async () => {
		const file = path.join(dirs.make('patchwork-secrets-'), 'secrets.json');
		const store = new FileSecretStore(file);
		await Promise.all(['a', 'b', 'c', 'd'].map((name) => store.set(name, `${name}-value`)));
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
			a: 'a-value',
			b: 'b-value',
			c: 'c-value',
			d: 'd-value'
		});
	});

	it('sets a damaged file aside instead of saving over it', async () => {
		const dir = dirs.make('patchwork-secrets-');
		const file = path.join(dir, 'secrets.json');
		writeFileSync(file, '{"githubToken":"ghp_1",');
		const store = new FileSecretStore(file);

		expect(await store.get('githubToken')).toBeNull();
		// Kept where agents can't read it, like the file itself.
		const folder = path.join(dir, 'secrets.json.d');
		const aside = readdirSync(folder).find((name) => name.startsWith('secrets.json.corrupt-'));
		expect(aside).toBeDefined();
		expect(readFileSync(path.join(folder, aside!), 'utf8')).toBe('{"githubToken":"ghp_1",');

		await store.set('openaiApiKey', 'sk-1');
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ openaiApiKey: 'sk-1' });
	});

	it('doesn’t save when the file can’t be read for another reason', async () => {
		const dir = dirs.make('patchwork-secrets-');
		const file = path.join(dir, 'secrets.json');
		mkdirSync(file);
		const store = new FileSecretStore(file);
		await expect(store.get('githubToken')).rejects.toThrow();
		await expect(store.set('githubToken', 'ghp_1')).rejects.toThrow();
		expect(statSync(file).isDirectory()).toBe(true);
	});
});
