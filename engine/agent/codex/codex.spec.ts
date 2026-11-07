import { describe, expect, it } from 'vitest';
import { codexSandbox, describeCodexEvent, isCodexSignInError } from './index';

describe('codexSandbox', () => {
	it('turns the policy into a Codex permissions profile and environment filter', () => {
		const overrides = codexSandbox({
			writable: ['/wt', '/repo/.git/worktrees/task'],
			allowedDomains: ['registry.npmjs.org'],
			deniedFiles: ['/home/me/.ssh', 'C:\\Users\\me\\.ssh'],
			deniedEnv: ['GITHUB_TOKEN', 'CODEX_API_KEY']
		});
		expect(overrides).toEqual([
			'default_permissions="patchwork"',
			'permissions.patchwork.filesystem={":root"="read","/wt"="write","/repo/.git/worktrees/task"="write","/home/me/.ssh"="deny","C:\\\\Users\\\\me\\\\.ssh"="deny"}',
			'permissions.patchwork.network={enabled=true,domains={"registry.npmjs.org"="allow"}}',
			'features.network_proxy=true',
			'shell_environment_policy.ignore_default_excludes=false',
			'shell_environment_policy.filters={"GITHUB_TOKEN"="exclude","CODEX_API_KEY"="exclude"}'
		]);
	});

	it('writes nowhere when the policy has no writable folders', () => {
		const [, filesystem] = codexSandbox({
			writable: [],
			allowedDomains: [],
			deniedFiles: [],
			deniedEnv: []
		});
		expect(filesystem).toBe('permissions.patchwork.filesystem={":root"="read"}');
	});
});

describe('describeCodexEvent', () => {
	const cwd = '/wt';

	it('logs commands when they start, without the shell wrapper', () => {
		const command = {
			id: '1',
			type: 'command_execution' as const,
			command: "/bin/bash -lc 'npm test'",
			aggregated_output: '',
			status: 'in_progress' as const
		};
		expect(describeCodexEvent({ type: 'item.started', item: command }, cwd)).toEqual([
			{ kind: 'tool', text: '$ npm test' }
		]);
		expect(
			describeCodexEvent({ type: 'item.completed', item: { ...command, status: 'completed' } }, cwd)
		).toEqual([]);
	});

	it('logs messages, file changes and errors', () => {
		expect(
			describeCodexEvent(
				{ type: 'item.completed', item: { id: '2', type: 'agent_message', text: ' Done. ' } },
				cwd
			)
		).toEqual([{ kind: 'assistant', text: 'Done.' }]);
		expect(
			describeCodexEvent(
				{
					type: 'item.completed',
					item: {
						id: '3',
						type: 'file_change',
						status: 'completed',
						changes: [
							{ path: '/wt/src/a.ts', kind: 'update' },
							{ path: 'src/b.ts', kind: 'add' }
						]
					}
				},
				cwd
			)
		).toEqual([
			{ kind: 'tool', text: 'Edit src/a.ts' },
			{ kind: 'tool', text: 'Write src/b.ts' }
		]);
		expect(
			describeCodexEvent(
				{ type: 'item.completed', item: { id: '4', type: 'error', message: 'Patch failed' } },
				cwd
			)
		).toEqual([{ kind: 'error', text: 'Patch failed' }]);
	});
});

describe('isCodexSignInError', () => {
	it('recognizes a missing login or bad key', () => {
		expect(isCodexSignInError('unexpected status 401 Unauthorized')).toBe(true);
		expect(isCodexSignInError('Not logged in. Run codex login.')).toBe(true);
		expect(isCodexSignInError('Tests failed: 4010 assertions')).toBe(false);
	});
});
