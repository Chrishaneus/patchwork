import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Repository } from '#lib/engine/contract.js';
import { tempDirs } from '../../test-helpers';
import type { AgentRunInput } from '../runner';
import {
	codexSandbox,
	codexSandboxSupport,
	createCodexAgentRunner,
	describeCodexItem,
	findCodexBinary,
	isCodexSignInError
} from './index';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('codexSandboxSupport', () => {
	/** A stand-in for the codex binary that exits with `code` and records its arguments. */
	function fakeCodex(code: number) {
		const dir = dirs.make('patchwork-codex-');
		const file = path.join(dir, 'codex');
		writeFileSync(file, `#!/bin/sh\necho "$@" > "${dir}/args"\nexit ${code}\n`);
		chmodSync(file, 0o755);
		return file;
	}

	it('runs a command in Codex’s sandbox, under rules like a task’s', () => {
		const codex = fakeCodex(0);
		expect(codexSandboxSupport(codex, 'linux')).toEqual({
			available: true,
			missing: [],
			blocked: false,
			setup: false
		});
		const args = readFileSync(path.join(path.dirname(codex), 'args'), 'utf8').trim();
		expect(args).toMatch(/^sandbox -c default_permissions="patchwork" .*"="deny".* -- true$/s);
		expect(codexSandboxSupport(fakeCodex(1), 'linux')).toEqual({
			available: false,
			missing: [],
			blocked: true,
			setup: false
		});
	});

	it('offers the elevated setup when the sandbox fails on Windows', () => {
		expect(codexSandboxSupport(fakeCodex(1), 'win32')).toMatchObject({
			available: false,
			setup: true
		});
	});

	it('is always there on macOS, and not without the binary', () => {
		expect(codexSandboxSupport(undefined, 'darwin').available).toBe(true);
		expect(codexSandboxSupport(undefined, 'linux')).toEqual({
			available: false,
			missing: [],
			blocked: false,
			setup: false
		});
	});
});

describe('findCodexBinary', () => {
	it('finds the native binary in this platform’s package', () => {
		const binary = findCodexBinary((id) => `/app/node_modules/${id}`);
		expect(binary).toMatch(
			new RegExp(`/app/node_modules/@openai/codex-${process.platform}-${process.arch}/vendor/`)
		);
		expect(findCodexBinary(() => '/app.asar/node_modules/x/package.json')).toContain(
			`app.asar.unpacked${path.sep}`
		);
		expect(
			findCodexBinary(() => {
				throw new Error('not installed');
			})
		).toBeUndefined();
	});
});

describe('codexSandbox', () => {
	const policy = {
		writable: ['/wt', '/repo/.git/worktrees/task'],
		allowedDomains: ['registry.npmjs.org'],
		deniedFiles: ['/home/me/.ssh', 'C:\\Users\\me\\.ssh'],
		deniedEnv: ['GITHUB_TOKEN', 'CODEX_API_KEY']
	};

	it('turns the policy into a Codex permissions profile and environment filter', () => {
		const overrides = codexSandbox(policy, 'linux');
		expect(overrides).toEqual([
			'default_permissions="patchwork"',
			'permissions.patchwork.filesystem={":root"="read","/wt"="write","/repo/.git/worktrees/task"="write","/home/me/.ssh"="deny","C:\\\\Users\\\\me\\\\.ssh"="deny"}',
			'permissions.patchwork.network={enabled=true,domains={"registry.npmjs.org"="allow"}}',
			'features.network_proxy=true',
			'shell_environment_policy.ignore_default_excludes=false',
			'shell_environment_policy.filters={"GITHUB_TOKEN"="exclude","CODEX_API_KEY"="exclude"}'
		]);
	});

	it('uses a Windows sandbox that can deny files', () => {
		const overrides = codexSandbox(policy, 'win32');
		expect(overrides).toContain(
			'permissions.patchwork.network={enabled=true,allow_local_binding=true,domains={"registry.npmjs.org"="allow"}}'
		);
		expect(overrides.slice(-2)).toEqual(['features.prefer_mxc=true', 'windows.sandbox="elevated"']);
	});

	it('writes nowhere when the policy has no writable folders', () => {
		const [, filesystem] = codexSandbox(
			{ writable: [], allowedDomains: [], deniedFiles: [], deniedEnv: [] },
			'linux'
		);
		expect(filesystem).toBe('permissions.patchwork.filesystem={":root"="read"}');
	});
});

describe('describeCodexItem', () => {
	const cwd = '/wt';

	it('logs commands when they start, without the shell wrapper', () => {
		const command = {
			id: '1',
			type: 'commandExecution' as const,
			command: "/bin/bash -lc 'npm test'",
			status: 'inProgress'
		};
		expect(describeCodexItem('started', command, cwd)).toEqual([
			{ kind: 'tool', text: '$ npm test' }
		]);
		expect(describeCodexItem('completed', { ...command, status: 'completed' }, cwd)).toEqual([]);
	});

	it('logs messages and file changes', () => {
		expect(
			describeCodexItem('completed', { id: '2', type: 'agentMessage', text: ' Done. ' }, cwd)
		).toEqual([{ kind: 'assistant', text: 'Done.' }]);
		expect(
			describeCodexItem(
				'completed',
				{
					id: '3',
					type: 'fileChange',
					status: 'completed',
					changes: [
						{ path: '/wt/src/a.ts', kind: { type: 'update' } },
						{ path: 'src/b.ts', kind: { type: 'add' } }
					]
				},
				cwd
			)
		).toEqual([
			{ kind: 'tool', text: 'Edit src/a.ts' },
			{ kind: 'tool', text: 'Write src/b.ts' }
		]);
	});
});

describe('createCodexAgentRunner', () => {
	/**
	 * A stand-in for `codex app-server`: it records how it was started, asks to run one command
	 * outside the sandbox, and answers with the decision it got.
	 */
	function fakeAppServer() {
		const dir = dirs.make('patchwork-codex-');
		const file = path.join(dir, 'codex');
		writeFileSync(
			file,
			`#!/usr/bin/env node
const fs = require('node:fs');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'started.json'))}, JSON.stringify({ args: process.argv.slice(2), key: process.env.PATCHWORK_OPENAI_API_KEY ?? null }));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
	const m = JSON.parse(line);
	if (m.method === 'initialize') send({ id: m.id, result: {} });
	if (m.method === 'thread/start') {
		fs.writeFileSync(${JSON.stringify(path.join(dir, 'thread.json'))}, JSON.stringify(m.params));
		send({ id: m.id, result: { thread: { id: 't1' } } });
	}
	if (m.method === 'turn/start') {
		send({ id: m.id, result: { turn: { id: 'u1' } } });
		send({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: "/bin/bash -lc 'docker compose up -d'", status: 'inProgress' } } });
		send({ id: 0, method: 'item/commandExecution/requestApproval', params: { kind: 'command', command: "/bin/bash -lc 'docker compose up -d'", reason: 'The tests need the database.' } });
	}
	if (m.id === 0 && m.result) {
		send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'Decision: ' + m.result.decision } } });
		send({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed', error: null } } });
	}
});
`
		);
		chmodSync(file, 0o755);
		const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
		return { file, read };
	}

	const repository = {
		id: 'r1',
		name: 'repo',
		path: '/repo',
		slug: null,
		provider: null,
		defaultBranch: 'main',
		checkCommand: null,
		createdAt: ''
	} as unknown as Repository;
	const input = (overrides: Partial<AgentRunInput>): AgentRunInput => ({
		cwd: dirs.make('patchwork-wt-'),
		instruction: 'Start the database',
		repository,
		branch: 'patchwork/x',
		baseBranch: 'main',
		model: 'gpt-6-luna',
		apiKey: null,
		signal: new AbortController().signal,
		log: () => {},
		...overrides
	});

	it.skipIf(process.platform === 'win32')(
		'asks the user before Codex runs a command outside the sandbox',
		async () => {
			const codex = fakeAppServer();
			const asked: { command: string; reason: string | null }[] = [];
			const log: string[] = [];
			const result = await createCodexAgentRunner({ executable: codex.file })(
				input({
					requestApproval: async (request) => {
						asked.push(request);
						return true;
					},
					log: (entry) => log.push(entry.text)
				})
			);
			expect(asked).toEqual([
				{ command: 'docker compose up -d', reason: 'The tests need the database.' }
			]);
			expect(result.summary).toBe('Decision: accept');
			expect(log).toContain('$ docker compose up -d');
			expect(codex.read('thread.json')).toMatchObject({
				approvalPolicy: 'on-request',
				ephemeral: true
			});
			expect(codex.read('thread.json').developerInstructions).toContain('outside the sandbox');
			expect(codex.read('started.json')).toMatchObject({ key: null });
		}
	);

	it.skipIf(process.platform === 'win32')(
		'declines when nobody can answer, and signs in with a saved key nobody else sees',
		async () => {
			const codex = fakeAppServer();
			const result = await createCodexAgentRunner({ executable: codex.file })(
				input({ apiKey: 'sk-saved' })
			);
			expect(result.summary).toBe('Decision: decline');
			expect(codex.read('thread.json')).toMatchObject({ approvalPolicy: 'never' });
			const started = codex.read('started.json');
			expect(started.key).toBe('sk-saved');
			expect(started.args.join(' ')).toContain('model_provider="patchwork-openai"');
			expect(started.args.join(' ')).toMatch(/filters=\{[^}]*"PATCHWORK_OPENAI_API_KEY"="exclude"/);
		}
	);
});

describe('isCodexSignInError', () => {
	it('recognizes a missing login or bad key', () => {
		expect(isCodexSignInError('unexpected status 401 Unauthorized')).toBe(true);
		expect(isCodexSignInError('Not logged in. Run codex login.')).toBe(true);
		expect(isCodexSignInError('Tests failed: 4010 assertions')).toBe(false);
	});
});
