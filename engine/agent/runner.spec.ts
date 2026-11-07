import { afterEach, describe, expect, it } from 'vitest';
import { agentEnv, isSignInError } from './runner';

describe('isSignInError', () => {
	it('recognizes a missing login or bad key', () => {
		expect(isSignInError('Not logged in · Please run /login')).toBe(true);
		expect(isSignInError('Invalid API key · Fix external API key')).toBe(true);
		expect(isSignInError('Tool failed: file not found')).toBe(false);
	});
});

describe('agentEnv', () => {
	const names = ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'PATCHWORK_TOKEN', 'ANTHROPIC_API_KEY'];
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	afterEach(() => {
		for (const name of names) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	it('gives the agent no tokens, only the Anthropic key it signs in with', () => {
		for (const name of names) process.env[name] = `secret-${name}`;
		const env = agentEnv('sk-saved');
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.GITLAB_TOKEN).toBeUndefined();
		expect(env.PATCHWORK_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBe('sk-saved');
		expect(env.PATH).toBe(process.env.PATH);
		expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^patchwork\//);

		// Without a key the agent uses its own Claude login.
		expect(agentEnv(null).ANTHROPIC_API_KEY).toBeUndefined();
	});
});
