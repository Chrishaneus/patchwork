import { afterEach, describe, expect, it } from 'vitest';
import { claudeEnv, claudeSandbox, isClaudeSignInError } from './index';

describe('claudeSandbox', () => {
	const policy = {
		writable: ['/wt', '/repo/.git/worktrees/task'],
		allowedDomains: ['registry.npmjs.org'],
		deniedFiles: ['/home/me/.ssh'],
		deniedEnv: ['GITHUB_TOKEN']
	};

	it('lets the agent ask to run a command outside it only when someone can answer', () => {
		expect(claudeSandbox(policy, '/wt', true).allowUnsandboxedCommands).toBe(true);
	});

	it('enforces the policy with no way around it', () => {
		expect(claudeSandbox(policy, '/wt')).toEqual({
			enabled: true,
			autoAllowBashIfSandboxed: false,
			allowUnsandboxedCommands: false,
			network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true },
			filesystem: { allowWrite: ['/repo/.git/worktrees/task'] },
			credentials: {
				envVars: [{ name: 'GITHUB_TOKEN', mode: 'deny' }],
				files: [{ path: '/home/me/.ssh', mode: 'deny' }]
			}
		});
	});
});

describe('isClaudeSignInError', () => {
	it('recognizes a missing login or bad key', () => {
		expect(isClaudeSignInError('Not logged in · Please run /login')).toBe(true);
		expect(isClaudeSignInError('Invalid API key · Fix external API key')).toBe(true);
		expect(isClaudeSignInError('Tool failed: file not found')).toBe(false);
	});
});

describe('claudeEnv', () => {
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
		const env = claudeEnv('sk-saved');
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.GITLAB_TOKEN).toBeUndefined();
		expect(env.PATCHWORK_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBe('sk-saved');
		expect(env.PATH).toBe(process.env.PATH);
		expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^patchwork\//);

		// Without a key the agent uses its own Claude login.
		expect(claudeEnv(null).ANTHROPIC_API_KEY).toBeUndefined();
	});
});
