import path from 'node:path';
import type { CanUseTool, SandboxSettings, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { EngineError, type LogEntry } from '#lib/engine/contract.js';
import { withoutSecrets } from '../../core/env.js';
import { decideToolUse } from '../policy.js';
import { guidance, sandboxGuidance, short, type AgentRunner } from '../runner.js';
import {
	sandboxPolicy,
	sandboxSupport,
	type SandboxPolicy,
	type SandboxSupport
} from '../sandbox.js';

/**
 * The Claude Code binary, from the per-platform package the SDK ships it in. In a packaged app it
 * must run from app.asar.unpacked, because executables can't be started from inside the archive.
 */
export function findClaudeBinary(resolve: (id: string) => string): string | undefined {
	try {
		const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
		const binary = path.join(
			path.dirname(resolve(pkg)),
			process.platform === 'win32' ? 'claude.exe' : 'claude'
		);
		return binary.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
	} catch {
		return undefined;
	}
}

/** The task log's note when commands can't be sandboxed here. */
export function noSandboxNote(support: SandboxSupport) {
	return support.missing.length > 0
		? `Shell commands run without a sandbox: install ${support.missing.join(' and ')} to turn it on${support.install ? ` (${support.install})` : ''}.`
		: support.blocked
			? 'Shell commands run without a sandbox: this system doesn’t let bubblewrap create namespaces (in Docker, see compose.yaml).'
			: 'Shell commands run without a sandbox: it isn’t available on this system.';
}

/**
 * The policy as Claude Code's sandbox, which wraps each shell command (bubblewrap on Linux,
 * Seatbelt on macOS). With `canAsk`, the agent may ask to run one command outside it
 * (`dangerouslyDisableSandbox`), which `canUseTool` turns into a question for the user.
 */
export function claudeSandbox(policy: SandboxPolicy, cwd: string, canAsk = false): SandboxSettings {
	return {
		enabled: true,
		// Bash still goes through the tool policy as well.
		autoAllowBashIfSandboxed: false,
		allowUnsandboxedCommands: canAsk,
		network: { allowedDomains: policy.allowedDomains, strictAllowlist: true },
		// Claude Code lets commands write in the working directory unless it's denied.
		filesystem: {
			allowWrite: policy.writable.filter((dir) => dir !== cwd),
			...(policy.writable.includes(cwd) ? {} : { denyWrite: [cwd] })
		},
		credentials: {
			envVars: policy.deniedEnv.map((name) => ({ name, mode: 'deny' as const })),
			files: policy.deniedFiles.map((file) => ({ path: file, mode: 'deny' as const }))
		}
	};
}

/**
 * The environment for Claude Code: none of the app's tokens (the agent's shell commands inherit
 * it), only the Anthropic key the agent signs in with, when there is one.
 */
export function claudeEnv(apiKey: string | null) {
	return withoutSecrets({
		CLAUDE_AGENT_SDK_CLIENT_APP: 'patchwork/0.0.1',
		...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {})
	});
}

/** The agent couldn't sign in to Anthropic (no API key and no Claude login). */
export function isClaudeSignInError(text: string) {
	return /not logged in|please run \/login|invalid api key|authentication_error|x-api-key/i.test(
		text
	);
}

/** The agent's failure, with a clear message when it simply has no Anthropic credentials. */
function claudeError(text: string) {
	return isClaudeSignInError(text)
		? new EngineError(
				'agent_not_signed_in',
				'The agent has no Anthropic credentials. Add an API key in Settings → AI agent (or set ANTHROPIC_API_KEY), or sign in to Claude on this machine.'
			)
		: new EngineError('agent_failed', text);
}

function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
	const rel = (p: unknown) =>
		typeof p === 'string' ? path.relative(cwd, path.resolve(cwd, p)) || '.' : '';
	switch (name) {
		case 'Bash':
			return `$ ${short(input.command)}`;
		case 'Read':
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
			return `${name} ${rel(input.file_path)}`;
		case 'Grep':
		case 'Glob':
			return `${name} ${short(input.pattern)}`;
		case 'WebFetch':
			return `WebFetch ${short(input.url)}`;
		case 'WebSearch':
			return `WebSearch ${short(input.query)}`;
		default:
			return name;
	}
}

/** Turn one SDK message into log entries for the UI. */
export function describeClaudeMessage(message: SDKMessage, cwd: string): Omit<LogEntry, 'at'>[] {
	if (message.type === 'system' && message.subtype === 'init') {
		return [{ kind: 'info', text: `Agent started with ${message.model}` }];
	}
	if (message.type === 'assistant' && message.parent_tool_use_id === null) {
		const entries: Omit<LogEntry, 'at'>[] = [];
		for (const block of message.message.content) {
			if (block.type === 'text' && block.text.trim()) {
				entries.push({ kind: 'assistant', text: block.text.trim() });
			} else if (block.type === 'tool_use') {
				entries.push({
					kind: 'tool',
					text: describeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>, cwd)
				});
			}
		}
		return entries;
	}
	return [];
}

/** The real agent: the Claude Agent SDK (Claude Code as a library) running in the worktree. */
export function createClaudeAgentRunner(
	opts: {
		executable?: string;
		/** Files the agent's commands must never read, such as the app's saved tokens. */
		protectedFiles?: string[];
	} = {}
): AgentRunner {
	let support: SandboxSupport | undefined;
	return async (input) => {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		support ??= sandboxSupport();
		if (!support.available) input.log({ kind: 'info', text: noSandboxNote(support) });
		const abortController = new AbortController();
		const abort = () => abortController.abort();
		if (input.signal.aborted) abort();
		else input.signal.addEventListener('abort', abort, { once: true });

		const canAsk = support.available && !!input.requestApproval;

		const canUseTool: CanUseTool = async (toolName, toolInput) => {
			const decision = decideToolUse(
				toolName,
				toolInput,
				input.cwd,
				!!input.mode && input.mode !== 'code'
			);
			if (!decision.allow) {
				input.log({ kind: 'error', text: `Blocked ${toolName}: ${decision.reason}` });
				return { behavior: 'deny', message: decision.reason };
			}
			if (canAsk && toolName === 'Bash' && toolInput.dangerouslyDisableSandbox === true) {
				const allowed = await input.requestApproval?.({
					command: String(toolInput.command ?? ''),
					reason: typeof toolInput.description === 'string' ? toolInput.description : null
				});
				if (!allowed) {
					return {
						behavior: 'deny',
						message: 'The user did not allow this command outside the sandbox.'
					};
				}
			}
			return { behavior: 'allow', updatedInput: toolInput };
		};

		const env = claudeEnv(input.apiKey);

		try {
			const session = query({
				prompt: input.instruction,
				options: {
					cwd: input.cwd,
					model: input.model,
					abortController,
					// Every tool call that needs permission goes through our policy.
					permissionMode: 'default',
					canUseTool,
					systemPrompt: {
						type: 'preset',
						preset: 'claude_code',
						append: [guidance(input), ...(support.available ? [sandboxGuidance(canAsk)] : [])].join(
							'\n'
						)
					},
					...(support.available
						? {
								sandbox: claudeSandbox(
									sandboxPolicy({
										cwd: input.cwd,
										protectedFiles: opts.protectedFiles ?? [],
										readOnly: !!input.mode && input.mode !== 'code',
										workingCopies: input.workingCopies?.map((c) => c.path)
									}),
									input.cwd,
									canAsk
								)
							}
						: {}),
					// Load the repository's own CLAUDE.md and project settings, not this machine's.
					settingSources: ['project'],
					// No "Generated with Claude Code" footers in commits or PR descriptions.
					settings: { attribution: { commit: '', pr: '' } },
					env,
					pathToClaudeCodeExecutable: opts.executable
				}
			});

			let lastText = '';
			for await (const message of session) {
				for (const entry of describeClaudeMessage(message, input.cwd)) {
					if (entry.kind === 'assistant') lastText = entry.text;
					input.log(entry);
				}
				if (message.type !== 'result') continue;

				if (message.subtype !== 'success') {
					throw claudeError(message.errors.join('\n') || message.subtype);
				}
				if (message.is_error) throw claudeError(message.result);
				// The result usually repeats the last message; only log it when it adds something.
				if (message.result.trim() !== lastText) input.log({ kind: 'result', text: message.result });
				return {
					summary: message.result,
					costUsd: message.total_cost_usd,
					turns: message.num_turns
				};
			}
			throw new EngineError('agent_failed', 'The agent stopped without a result.');
		} catch (error) {
			if (
				!(error instanceof EngineError) &&
				error instanceof Error &&
				isClaudeSignInError(error.message)
			) {
				throw claudeError(error.message);
			}
			throw error;
		} finally {
			input.signal.removeEventListener('abort', abort);
		}
	};
}
