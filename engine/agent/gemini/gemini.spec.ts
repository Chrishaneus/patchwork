import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry, Repository } from '#lib/engine/contract.js';
import { providerOf } from '#lib/engine/models.js';
import { tempDirs } from '../../test-helpers';
import { createAgentRunner } from '../agents';
import type { AgentRunInput, AgentRunner } from '../runner';
import { srtSupport } from '../wrapped';
import {
	createGeminiAgentRunner,
	createGeminiStream,
	describeGeminiTool,
	apiErrorMessage,
	geminiSettings,
	type GeminiEvent
} from './index';

const dirs = tempDirs();
const PATH = process.env.PATH;
afterEach(() => {
	process.env.PATH = PATH;
	dirs.cleanup();
});

describe('Gemini models', () => {
	it('go to Gemini CLI, by catalogue entry or by name', async () => {
		expect(providerOf('gemini-3.1-pro-preview')).toBe('google');
		expect(providerOf('gemini-9-custom')).toBe('google');
		const called: string[] = [];
		const fake =
			(name: string): AgentRunner =>
			async () => {
				called.push(name);
				return { summary: name, costUsd: null, turns: null };
			};
		const run = createAgentRunner({
			claude: fake('claude'),
			codex: fake('codex'),
			gemini: fake('gemini')
		});
		for (const model of ['gemini-2.5-flash', 'gpt-6-luna', 'claude-opus-5-5'])
			await run({ model } as AgentRunInput);
		expect(called).toEqual(['gemini', 'codex', 'claude']);
	});
});

describe('createGeminiStream', () => {
	it('logs tool calls and answers, and keeps the text after the last tool as the summary', () => {
		const log: Omit<LogEntry, 'at'>[] = [];
		const stream = createGeminiStream('/work', (entry) => log.push(entry));
		const events: GeminiEvent[] = [
			{ type: 'init', session_id: 's', model: 'gemini-2.5-flash' },
			{ type: 'message', role: 'user', content: 'fix it' },
			{ type: 'message', role: 'assistant', content: 'Let me ', delta: true },
			{ type: 'message', role: 'assistant', content: 'look.', delta: true },
			{
				type: 'tool_use',
				tool_name: 'replace',
				tool_id: '1',
				parameters: { file_path: '/work/src/a.ts' }
			},
			{ type: 'tool_result', tool_id: '1', status: 'success' },
			{
				type: 'tool_use',
				tool_name: 'run_shell_command',
				tool_id: '2',
				parameters: { command: 'npm test' }
			},
			{
				type: 'tool_result',
				tool_id: '2',
				status: 'error',
				error: { message: 'Command failed' }
			},
			{ type: 'message', role: 'assistant', content: 'Fixed the ', delta: true },
			{ type: 'message', role: 'assistant', content: 'bug.', delta: true },
			{ type: 'result', status: 'success' }
		];
		for (const event of events) stream.push(event);

		expect(stream.finish()).toMatchObject({ summary: 'Fixed the bug.', status: 'success' });
		expect(log).toEqual([
			{ kind: 'assistant', text: 'Let me look.' },
			{ kind: 'tool', text: 'Edit src/a.ts' },
			{ kind: 'tool', text: '$ npm test' },
			{ kind: 'error', text: 'Command failed' },
			{ kind: 'assistant', text: 'Fixed the bug.' }
		]);
	});

	it('has no summary when the run failed', () => {
		const stream = createGeminiStream('/work', () => {});
		stream.push({ type: 'error', severity: 'error', message: 'quota exceeded' });
		stream.push({ type: 'result', status: 'error' });
		expect(stream.finish()).toMatchObject({ summary: null, lastError: 'quota exceeded' });
	});

	it('names tools in the log like the other agents do', () => {
		expect(describeGeminiTool('write_file', { file_path: 'docs/a.md' }, '/work')).toBe(
			'Write docs/a.md'
		);
		expect(describeGeminiTool('grep_search', { pattern: 'TODO' }, '/work')).toBe('Grep TODO');
		expect(describeGeminiTool('something_new', {}, '/work')).toBe('something_new');
	});
});

describe('geminiSettings', () => {
	it('signs in with the key and turns off what the repository could change', () => {
		expect(geminiSettings()).toMatchObject({
			security: { auth: { selectedType: 'gemini-api-key' } },
			advanced: { ignoreLocalEnv: true },
			hooksConfig: { enabled: false },
			tools: { sandbox: false }
		});
	});
});

const repository = { id: 'r', name: 'widgets', slug: 'acme/widgets' } as Repository;

function input(cwd: string, over: Partial<AgentRunInput> = {}): AgentRunInput {
	return {
		cwd,
		instruction: 'Add a greeting',
		repository,
		branch: 'patchwork/greeting',
		baseBranch: 'main',
		model: 'gemini-2.5-flash',
		apiKey: 'AIza-real-key',
		signal: new AbortController().signal,
		log: () => {},
		...over
	};
}

describe('createGeminiAgentRunner', () => {
	it('needs Gemini CLI, the sandbox and a key', async () => {
		const cwd = dirs.make('patchwork-gemini-work-');
		await expect(createGeminiAgentRunner({})(input(cwd))).rejects.toMatchObject({
			code: 'agent_failed'
		});

		// Without bubblewrap and socat there is no sandbox, so it doesn't run at all.
		process.env.PATH = '';
		const runner = createGeminiAgentRunner({ cli: '/nowhere/gemini.js', node: process.execPath });
		const error = await runner(input(cwd)).catch((e) => e);
		expect(error).toMatchObject({ code: 'agent_failed' });
		expect(error.message).toMatch(/only runs in a sandbox/);
		process.env.PATH = PATH;

		if (srtSupport().available) {
			await expect(runner(input(cwd, { apiKey: null }))).rejects.toMatchObject({
				code: 'agent_not_signed_in'
			});
		}
	});
});

/**
 * A stand-in for Gemini CLI: prints its events, starting with a message reporting what it saw
 * inside the sandbox, which ends up in the task log.
 */
const FAKE_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const emit = (event) => console.log(JSON.stringify(event));
const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
const home = process.env.GEMINI_CLI_HOME;
const seen = {
	key: process.env.GEMINI_API_KEY,
	model: at('--model'),
	approval: at('--approval-mode'),
	prompt: at('--prompt'),
	settings: JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')),
	writeHome: attempt(() => fs.writeFileSync(path.join(home, 'state.json'), '{}')),
	writeTemp: attempt(() => fs.writeFileSync(path.join(process.env.TMPDIR, 'scratch'), 'x')),
	writeWork: attempt(() => fs.writeFileSync('hello.txt', 'hi')),
};
emit({ type: 'init', session_id: 's', model: seen.model });
emit({ type: 'message', role: 'assistant', content: 'SEEN ' + JSON.stringify(seen), delta: true });
emit({ type: 'tool_use', tool_name: 'write_file', tool_id: '1', parameters: { file_path: 'hello.txt' } });
emit({ type: 'tool_result', tool_id: '1', status: seen.writeWork ? 'success' : 'error', error: seen.writeWork ? undefined : { message: 'EROFS' } });
emit({ type: 'message', role: 'assistant', content: 'Added hello.txt.', delta: true });
emit({ type: 'result', status: 'success' });
`;

describe.skipIf(!srtSupport().available)('createGeminiAgentRunner (real sandbox)', () => {
	function setup() {
		const root = dirs.make('patchwork-gemini-');
		const cwd = path.join(root, 'work');
		mkdirSync(cwd);
		const cli = path.join(root, 'gemini.cjs');
		writeFileSync(cli, FAKE_CLI);
		return { cwd, runner: createGeminiAgentRunner({ cli, node: process.execPath }) };
	}

	/** The stand-in's report of what it saw inside the sandbox, from the task log. */
	const seenIn = (log: Omit<LogEntry, 'at'>[]) =>
		JSON.parse(log.find((e) => e.text.startsWith('SEEN '))?.text.slice(5) ?? '{}');

	it(
		'runs Gemini CLI in the sandbox with its key masked, and returns its answer',
		{ timeout: 60_000 },
		async () => {
			const { cwd, runner } = setup();
			const log: Omit<LogEntry, 'at'>[] = [];
			const result = await runner(input(cwd, { log: (entry) => log.push(entry) }));

			expect(result.summary).toBe('Added hello.txt.');
			expect(existsSync(path.join(cwd, 'hello.txt'))).toBe(true);
			const seen = seenIn(log);
			expect(seen).toMatchObject({
				model: 'gemini-2.5-flash',
				approval: 'yolo',
				settings: { security: { auth: { selectedType: 'gemini-api-key' } } },
				writeHome: true,
				// srt's TMPDIR exists and is writable.
				writeTemp: true,
				writeWork: true
			});
			// A key is there for Gemini CLI to send, but not the real one.
			expect(seen.key).toBeTruthy();
			expect(seen.key).not.toBe('AIza-real-key');
			expect(seen.prompt).toMatch(/^You are working in an isolated git worktree/);
			expect(seen.prompt).toMatch(/Add a greeting$/);
			expect(log.map((e) => e.text).filter((t) => !t.startsWith('SEEN '))).toEqual([
				'Agent started with Gemini CLI (gemini-2.5-flash), in srt',
				'Write hello.txt',
				'Added hello.txt.'
			]);
		}
	);

	it('writes nowhere in the read-only workflows', { timeout: 60_000 }, async () => {
		const { cwd, runner } = setup();
		const log: Omit<LogEntry, 'at'>[] = [];
		await runner(input(cwd, { mode: 'explore', log: (entry) => log.push(entry) }));
		expect(existsSync(path.join(cwd, 'hello.txt'))).toBe(false);
		expect(seenIn(log)).toMatchObject({ writeWork: false, writeHome: true });
		expect(log.map((e) => e.text)).toContain('EROFS');
	});
});

describe('apiErrorMessage', () => {
	it('finds the readable message inside Gemini CLI’s wrapped API errors', () => {
		const wrapped =
			'[API Error: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n","code":400,"status":"Bad Request"}}]';
		expect(apiErrorMessage(wrapped)).toBe('API key not valid. Please pass a valid API key.');
		expect(apiErrorMessage('plain failure')).toBe('plain failure');
	});
});
