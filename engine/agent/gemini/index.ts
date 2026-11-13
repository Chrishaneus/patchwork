import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { EngineError, type LogEntry } from '#lib/engine/contract.js';
import { guidance, sandboxGuidance, short, type AgentRunner } from '../runner.js';
import { sandboxPolicy, type SandboxSupport } from '../sandbox.js';
import { srtSupport, wrapInSandbox } from '../wrapped.js';

/**
 * Gemini CLI (`@google/gemini-cli`, pinned): headless with `-p`, printing a stream of JSON
 * events. It has no sandbox we can give our rules to, only "ask before running", so the whole
 * agent runs inside srt (`wrapped.ts`) with the same policy as the other agents. It never runs
 * without it.
 */

/** Where the Gemini API is; the only host its key is sent to. */
export const GEMINI_API_HOSTS = ['generativelanguage.googleapis.com'];

/** Gemini CLI's entry point, from the installed package. */
export function findGeminiCli(resolve: (id: string) => string): string | undefined {
	try {
		const cli = path.join(
			path.dirname(resolve('@google/gemini-cli/package.json')),
			'bundle',
			'gemini.js'
		);
		return cli.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
	} catch {
		return undefined;
	}
}

/** Whether Gemini CLI can run here: it's installed with the app, and srt can sandbox it. */
export function geminiSandboxSupport(cli: string | undefined): SandboxSupport {
	if (!cli) return { available: false, missing: [], blocked: false, setup: false };
	return srtSupport();
}

/**
 * Gemini's settings for a run, as the user settings in its fresh home: sign in with the key, no
 * auto-updates or usage statistics (srt would block them anyway), no `.env` from the
 * repository, no hooks, no interactive shell, and not Gemini's own sandbox (srt is the sandbox). A system settings
 * file would win over the repository's `.gemini/settings.json` too, but Gemini only reads one
 * in a folder owned by root. Whatever the repository's settings change still runs inside srt.
 */
export function geminiSettings() {
	return {
		security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } },
		general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
		privacy: { usageStatisticsEnabled: false },
		telemetry: { enabled: false },
		advanced: { ignoreLocalEnv: true },
		hooksConfig: { enabled: false },
		// Plain child processes for shell commands, not node-pty (left out of the desktop app).
		tools: { sandbox: false, shell: { enableInteractiveShell: false } }
	};
}

/** One line of `--output-format stream-json`. */
export type GeminiEvent =
	| { type: 'init'; session_id?: string; model?: string }
	| { type: 'message'; role: 'user' | 'assistant'; content: string; delta?: boolean }
	| { type: 'tool_use'; tool_name: string; tool_id: string; parameters?: Record<string, unknown> }
	| {
			type: 'tool_result';
			tool_id: string;
			status: 'success' | 'error';
			output?: string;
			error?: { type?: string; message?: string };
	  }
	| { type: 'error'; severity: 'warning' | 'error'; message: string }
	| {
			type: 'result';
			status: 'success' | 'error';
			error?: { type?: string; message?: string };
			stats?: unknown;
	  };

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * The readable part of an API error, which Gemini CLI wraps as `[API Error: {json}]`, sometimes
 * twice: the innermost `"message"`.
 */
export function apiErrorMessage(text: string): string {
	const messages = [...text.matchAll(/\\*"message\\*"\s*:\s*\\*"((?:[^"\\]|\\.)*?)\\*"/g)]
		.map((m) =>
			m[1]
				.replace(/\\[nt]/g, ' ')
				.replace(/\\+/g, '')
				.trim()
		)
		.filter((m) => m && !m.startsWith('{'));
	return messages.at(-1) ?? text;
}

/** A tool call as a log line, with paths relative to the working copy. */
export function describeGeminiTool(
	name: string,
	params: Record<string, unknown> = {},
	cwd: string
): string {
	const file = str(params.file_path) || str(params.absolute_path) || str(params.path);
	const rel = file ? path.relative(cwd, path.resolve(cwd, file)) || '.' : '';
	switch (name) {
		case 'run_shell_command':
			return `$ ${short(params.command)}`;
		case 'write_file':
			return `Write ${rel}`;
		case 'replace':
			return `Edit ${rel}`;
		case 'read_file':
			return `Read ${rel}`;
		case 'read_many_files':
			return `Read ${short((params.include as unknown[] | undefined)?.join(', ') ?? '')}`;
		case 'list_directory':
			return `List ${path.relative(cwd, path.resolve(cwd, str(params.dir_path) || file || '.')) || '.'}`;
		case 'glob':
			return `Glob ${short(params.pattern)}`;
		case 'grep_search':
		case 'search_file_content':
			return `Grep ${short(params.pattern)}`;
		case 'google_web_search':
			return `WebSearch ${short(params.query)}`;
		case 'web_fetch':
			return `WebFetch ${short(params.prompt)}`;
		default:
			return name;
	}
}

/**
 * Turns Gemini's events into task-log entries and the final answer: the text after the last tool
 * call, the way Gemini's own `json` output picks its response.
 */
export function createGeminiStream(cwd: string, log: (entry: Omit<LogEntry, 'at'>) => void) {
	let text = '';
	let status: 'success' | 'error' | null = null;
	let lastError = '';
	const flush = () => {
		if (text.trim()) log({ kind: 'assistant', text: text.trim() });
	};
	return {
		push(event: GeminiEvent) {
			switch (event.type) {
				case 'message':
					if (event.role === 'assistant') text += event.content;
					break;
				case 'tool_use':
					flush();
					text = '';
					log({ kind: 'tool', text: describeGeminiTool(event.tool_name, event.parameters, cwd) });
					break;
				case 'tool_result':
					if (event.status === 'error' && event.error?.message)
						log({ kind: 'error', text: short(event.error.message, 300) });
					break;
				case 'error':
					if (event.severity === 'error') lastError = event.message;
					log({ kind: 'error', text: short(event.message, 300) });
					break;
				case 'result':
					status = event.status;
					if (event.error?.message) lastError = apiErrorMessage(event.error.message);
					break;
			}
		},
		/** The final answer once the run has ended, or null when it didn't succeed. */
		finish() {
			flush();
			return { summary: status === 'success' ? text.trim() : null, status, lastError };
		}
	};
}

/** Gemini CLI couldn't sign in: no key, or one the API refuses. */
export function isGeminiSignInError(text: string) {
	return /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|\b401\b|\b403\b|auth method|GEMINI_API_KEY/i.test(
		text
	);
}

function geminiError(text: string) {
	return isGeminiSignInError(text)
		? new EngineError(
				'agent_not_signed_in',
				'Gemini CLI has no usable Gemini API key. Add one in Settings → AI agent (or set GEMINI_API_KEY).'
			)
		: new EngineError('agent_failed', text || 'Gemini CLI stopped with an error.');
}

/** The variable Gemini CLI reads its key from; masked by srt. */
const KEY_ENV = 'GEMINI_API_KEY';

/**
 * The Google agent: Gemini CLI inside srt, in the worktree. It may write only there (nowhere in
 * read-only workflows) and in a fresh home folder of its own, reach only package registries and
 * the Gemini API, and never sees its key: srt puts that into requests to the API only.
 */
export function createGeminiAgentRunner(
	opts: {
		/** Gemini CLI's `bundle/gemini.js`. */
		cli?: string;
		/** Files the agent's commands must never read, such as the app's saved tokens. */
		protectedFiles?: string[];
		/** For tests: the program that runs the CLI script (default: this Node or Electron). */
		node?: string;
	} = {}
): AgentRunner {
	return async (input) => {
		if (!opts.cli)
			throw new EngineError('agent_failed', 'Gemini CLI isn’t installed with this app.');
		const support = srtSupport();
		if (!support.available) {
			const why =
				support.missing.length > 0
					? `install ${support.missing.join(' and ')}${support.install ? ` (${support.install})` : ''}`
					: support.blocked
						? 'this system doesn’t let bubblewrap create namespaces (in Docker, see compose.yaml)'
						: 'it isn’t available on this system yet';
			throw new EngineError(
				'agent_failed',
				`Gemini CLI only runs in a sandbox, and the sandbox can’t start here: ${why}.`
			);
		}
		if (!input.apiKey) throw geminiError('GEMINI_API_KEY');

		const readOnly = !!input.mode && input.mode !== 'code';
		const policy = sandboxPolicy({
			cwd: input.cwd,
			protectedFiles: opts.protectedFiles ?? [],
			readOnly
		});
		// A fresh home for Gemini's own state (sessions, caches) and settings, so it never reads
		// the user's ~/.gemini (logins, extensions, MCP servers).
		const home = mkdtempSync(path.join(tmpdir(), 'patchwork-gemini-home-'));
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify(geminiSettings()), {
			mode: 0o600
		});

		// Starts with the guidance, so the prompt is never read as a slash command.
		const prompt = [guidance(input), sandboxGuidance(false), '', input.instruction].join('\n');
		const wrapped = wrapInSandbox({
			policy: { ...policy, deniedEnv: [...policy.deniedEnv, KEY_ENV] },
			agent: {
				apiHosts: GEMINI_API_HOSTS,
				key: { env: KEY_ENV, value: input.apiKey },
				stateDirs: [home]
			},
			command: opts.node ?? process.execPath,
			args: [
				opts.cli,
				'--prompt',
				prompt,
				'--output-format',
				'stream-json',
				'--model',
				input.model,
				// srt is the boundary, so Gemini needn't ask before each tool.
				'--approval-mode',
				'yolo',
				'--skip-trust'
			],
			env: {
				...process.env,
				GEMINI_CLI_HOME: home,
				GEMINI_CLI_TRUST_WORKSPACE: 'true',
				// It would otherwise start itself again with more memory.
				GEMINI_CLI_NO_RELAUNCH: 'true',
				NO_BROWSER: 'true'
			}
		});

		const stream = createGeminiStream(input.cwd, input.log);
		let stderr = '';
		const child = spawn(wrapped.command, wrapped.args, {
			cwd: input.cwd,
			env: wrapped.env as NodeJS.ProcessEnv,
			stdio: ['ignore', 'pipe', 'pipe'],
			// Its own process group, so stopping it stops srt and everything it started.
			detached: process.platform !== 'win32'
		});
		const stop = () => {
			try {
				if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
				else child.kill('SIGTERM');
			} catch {
				// Already gone.
			}
		};
		input.signal.addEventListener('abort', stop, { once: true });
		child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8000)));
		const lines = createInterface({ input: child.stdout });
		lines.on('line', (line) => {
			if (!line.startsWith('{')) return;
			try {
				stream.push(JSON.parse(line) as GeminiEvent);
			} catch {
				// Not one of its events.
			}
		});
		input.log({ kind: 'info', text: `Agent started with Gemini CLI (${input.model}), in srt` });

		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.on('error', reject);
				child.on('close', resolve);
			});
			if (input.signal.aborted) throw input.signal.reason;
			const { summary, lastError } = stream.finish();
			if (code !== 0 || summary === null) {
				const detail = lastError || stderr.trim().split('\n').slice(-3).join('\n');
				throw geminiError(code === 53 ? 'Gemini CLI reached its turn limit.' : detail);
			}
			if (!summary) throw new EngineError('agent_failed', 'The agent stopped without a summary.');
			return { summary, costUsd: null, turns: null };
		} finally {
			input.signal.removeEventListener('abort', stop);
			lines.close();
			wrapped.cleanup();
			rmSync(home, { recursive: true, force: true });
		}
	};
}
