import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../core/secrets';
import { createCredentials } from './credentials';

describe('createCredentials', () => {
	const saved = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
	afterEach(() => {
		for (const [name, value] of [
			['ANTHROPIC_API_KEY', saved.anthropic],
			['OPENAI_API_KEY', saved.openai]
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it('gives each agent its own provider’s key: saved first, then the environment', async () => {
		process.env.ANTHROPIC_API_KEY = 'env-anthropic';
		process.env.OPENAI_API_KEY = 'env-openai';
		const credentials = createCredentials(new MemorySecretStore(), {
			signedInGitHubToken: async () => null
		});
		expect(await credentials.getApiKey('anthropic')).toBe('env-anthropic');
		expect(await credentials.getApiKey('openai')).toBe('env-openai');

		await credentials.saveOpenAiKey('saved-openai');
		expect(await credentials.getApiKey('openai')).toBe('saved-openai');
		expect(await credentials.getApiKey('anthropic')).toBe('env-anthropic');
		expect(await credentials.sources()).toMatchObject({
			anthropicApiKey: 'environment',
			openaiApiKey: 'saved'
		});

		delete process.env.OPENAI_API_KEY;
		await credentials.saveOpenAiKey(null);
		// No key: Codex uses its own login.
		expect(await credentials.getApiKey('openai')).toBeNull();
	});
});
