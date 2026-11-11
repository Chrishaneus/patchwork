import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../test-helpers';
import type { SandboxPolicy } from './sandbox';
import { srtConfig, srtSupport, wrapInSandbox } from './wrapped';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
	writable: ['/work'],
	allowedDomains: ['registry.npmjs.org'],
	deniedFiles: ['/home/me/.ssh'],
	deniedEnv: ['GITHUB_TOKEN', 'GEMINI_API_KEY'],
	...over
});

describe('srtConfig', () => {
	it('turns the policy into srt settings, masking the agent’s key for its API hosts only', () => {
		const config = srtConfig(policy(), {
			apiHosts: ['generativelanguage.googleapis.com'],
			key: { env: 'GEMINI_API_KEY', value: 'real' },
			stateDirs: ['/home/me/.gemini']
		});
		expect(config.network).toEqual({
			allowedDomains: ['registry.npmjs.org', 'generativelanguage.googleapis.com'],
			deniedDomains: [],
			strictAllowlist: true,
			tlsTerminate: {}
		});
		expect(config.filesystem).toMatchObject({
			denyRead: ['/home/me/.ssh'],
			allowWrite: ['/work', '/home/me/.gemini']
		});
		expect(config.credentials.envVars).toEqual([
			{ name: 'GITHUB_TOKEN', mode: 'deny' },
			{ name: 'GEMINI_API_KEY', mode: 'mask', injectHosts: ['generativelanguage.googleapis.com'] }
		]);
		// The key itself never goes into the settings file.
		expect(JSON.stringify(config)).not.toContain('real');
	});

	it('writes nowhere for the read-only workflows', () => {
		const config = srtConfig(policy({ writable: [] }), { apiHosts: ['api.example.com'] });
		expect(config.filesystem.allowWrite).toEqual([]);
		expect(config.network).not.toHaveProperty('tlsTerminate');
	});
});

/** What the stand-in agent found it could do, from inside the sandbox. */
const PROBE = `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [work, outside, secret] = process.argv.slice(2);
const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
const curl = (url) => {
	try {
		return execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', url], { encoding: 'utf8' });
	} catch (e) { return String(e.stdout ?? 'failed'); }
};
console.log(JSON.stringify({
	writeInside: attempt(() => fs.writeFileSync(work + '/inside.txt', 'x')),
	writeOutside: attempt(() => fs.writeFileSync(outside + '/outside.txt', 'x')),
	readSecret: attempt(() => fs.readFileSync(secret, 'utf8')),
	githubToken: process.env.GITHUB_TOKEN ?? null,
	apiKey: process.env.FAKE_API_KEY ?? null,
	// A shell command the agent runs gets the same rules.
	shellWriteOutside: attempt(() => execFileSync('sh', ['-c', 'echo x > ' + outside + '/shell.txt'])),
	github: curl('https://github.com/'),
}));
`;

function runToEnd(command: string, args: string[], env: Record<string, string | undefined>) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

const srtRuns = srtSupport().available;

describe.skipIf(!srtRuns)('wrapInSandbox (real sandbox)', () => {
	it('holds the agent and its commands to the policy', { timeout: 60_000 }, async () => {
		const root = dirs.make('patchwork-srt-test-');
		const work = path.join(root, 'work');
		const outside = path.join(root, 'outside');
		const secrets = path.join(root, 'secrets');
		for (const dir of [work, outside, secrets]) mkdirSync(dir);
		const secret = path.join(secrets, 'token.txt');
		writeFileSync(secret, 'ghp_secret');
		const script = path.join(root, 'agent.cjs');
		writeFileSync(script, PROBE);

		const wrapped = wrapInSandbox({
			policy: {
				writable: [work],
				allowedDomains: ['registry.npmjs.org'],
				deniedFiles: [secrets],
				deniedEnv: ['GITHUB_TOKEN', 'FAKE_API_KEY']
			},
			agent: { apiHosts: ['api.example.com'], key: { env: 'FAKE_API_KEY', value: 'sk-real' } },
			command: process.execPath,
			args: [script, work, outside, secret],
			env: { ...process.env, GITHUB_TOKEN: 'ghp_from_env' }
		});
		// srt needs the real key to put it back on the way out; nothing else secret reaches it.
		expect(wrapped.env).toMatchObject({ FAKE_API_KEY: 'sk-real', NODE_USE_ENV_PROXY: '1' });
		expect(wrapped.env.GITHUB_TOKEN).toBeUndefined();
		try {
			const result = await runToEnd(wrapped.command, wrapped.args, wrapped.env);
			expect(result.code, result.stderr).toBe(0);
			const found = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
			expect(found).toMatchObject({
				writeInside: true,
				writeOutside: false,
				readSecret: false,
				githubToken: null,
				shellWriteOutside: false
			});
			// The proxy refuses hosts that aren't allowed.
			expect(found.github).not.toMatch(/^[23]\d\d$/);
			// The key is there, but not its real value.
			expect(found.apiKey).toBeTruthy();
			expect(found.apiKey).not.toBe('sk-real');
			expect(existsSync(path.join(outside, 'outside.txt'))).toBe(false);
		} finally {
			wrapped.cleanup();
		}
	});
});
