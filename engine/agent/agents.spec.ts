import { describe, expect, it } from 'vitest';
import { providerOf } from '#lib/engine/models.js';
import { createAgentRunner } from './agents';
import type { AgentRunInput, AgentRunner } from './runner';

describe('providerOf', () => {
	it('knows the catalogue, and guesses custom IDs by name', () => {
		expect(providerOf('claude-opus-5-5')).toBe('anthropic');
		expect(providerOf('gpt-6.1-sol')).toBe('openai');
		expect(providerOf('gpt-7-preview')).toBe('openai');
		expect(providerOf('o5-mini')).toBe('openai');
		expect(providerOf('claude-next')).toBe('anthropic');
	});
});

describe('createAgentRunner', () => {
	it('runs OpenAI models in Codex and the rest in Claude Code', async () => {
		const ran: string[] = [];
		const fake =
			(name: string): AgentRunner =>
			async () => {
				ran.push(name);
				return { summary: name, costUsd: null, turns: null };
			};
		const run = createAgentRunner({ claude: fake('claude'), codex: fake('codex') });
		const input = (model: string) => ({ model }) as AgentRunInput;

		await run(input('gpt-6.1-sol'));
		await run(input('claude-opus-5-5'));
		expect(ran).toEqual(['codex', 'claude']);
	});
});
