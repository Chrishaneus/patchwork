import path from 'node:path';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { EngineError, type LogEntry } from '#lib/engine/contract.js';
import { withoutSecrets } from '../../core/env.js';
import { guidance, SANDBOX_GUIDANCE, short, type AgentRunner } from '../runner.js';
import { sandboxPolicy, type SandboxPolicy } from '../sandbox.js';

const PROFILE = 'patchwork';

/** A TOML inline table; keys are quoted because paths and hosts contain dots and colons. */
const tomlTable = (entries: Record<string, string>) =>
	`{${Object.entries(entries)
		.map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
		.join(',')}}`;

/**
 * The policy as Codex's own sandbox: a permissions profile that can read everything except the
 * denied files, write only the writable folders, and reach only the allowed hosts through
 * Codex's network proxy; the denied variables are filtered out of every command's environment.
 * Returned as `--config` overrides.
 */
export function codexSandbox(policy: SandboxPolicy): string[] {
	const filesystem: Record<string, string> = { ':root': 'read' };
	for (const dir of policy.writable) filesystem[dir] = 'write';
	for (const file of policy.deniedFiles) filesystem[file] = 'deny';
	const domains = Object.fromEntries(policy.allowedDomains.map((host) => [host, 'allow']));
	const filters = Object.fromEntries(policy.deniedEnv.map((name) => [name, 'exclude']));
	return [
		`default_permissions=${JSON.stringify(PROFILE)}`,
		`permissions.${PROFILE}.filesystem=${tomlTable(filesystem)}`,
		`permissions.${PROFILE}.network={enabled=true,domains=${tomlTable(domains)}}`,
		// Without the proxy, the domain rules aren't enforced.
		'features.network_proxy=true',
		'shell_environment_policy.ignore_default_excludes=false',
		`shell_environment_policy.filters=${tomlTable(filters)}`
	];
}

/** The command Codex ran, without the `bash -lc '…'` it wraps every command in. */
function unwrap(command: string) {
	const match = /^\S*\b(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
	return match ? match[2] : command;
}

/** Turn one Codex event into log entries for the UI. */
export function describeCodexEvent(event: ThreadEvent, cwd: string): Omit<LogEntry, 'at'>[] {
	// Commands are logged when they start: a failed one may never be reported as completed.
	if (event.type === 'item.started' && event.item.type === 'command_execution') {
		return [{ kind: 'tool', text: `$ ${short(unwrap(event.item.command))}` }];
	}
	if (event.type !== 'item.completed') return [];
	const item: ThreadItem = event.item;
	switch (item.type) {
		case 'agent_message':
			return item.text.trim() ? [{ kind: 'assistant', text: item.text.trim() }] : [];
		case 'file_change':
			return item.changes.map((change) => ({
				kind: 'tool' as const,
				text: `${change.kind === 'add' ? 'Write' : change.kind === 'delete' ? 'Delete' : 'Edit'} ${
					path.relative(cwd, path.resolve(cwd, change.path)) || '.'
				}`
			}));
		case 'web_search':
			return [{ kind: 'tool', text: `WebSearch ${short(item.query)}` }];
		case 'mcp_tool_call':
			return [{ kind: 'tool', text: `${item.server}.${item.tool}` }];
		case 'error':
			return [{ kind: 'error', text: item.message }];
		default:
			return [];
	}
}

/** Codex couldn't sign in to OpenAI (no API key and no `codex login`). */
export function isCodexSignInError(text: string) {
	return /\b401\b|unauthorized|not logged in|invalid api key|incorrect api key|codex login/i.test(
		text
	);
}

function codexError(text: string) {
	return isCodexSignInError(text)
		? new EngineError(
				'agent_not_signed_in',
				'Codex has no OpenAI credentials. Add an OpenAI API key in Settings → AI agent (or set OPENAI_API_KEY), or run `codex login` on this machine.'
			)
		: new EngineError('agent_failed', text);
}

/**
 * The OpenAI agent: Codex (through its SDK) running in the worktree, in its own sandbox. Codex
 * has no per-tool approval hook, so the sandbox is the whole boundary: read-only workflows get
 * no writable folders, and nothing can reach GitHub or GitLab or read a credential.
 */
export function createCodexAgentRunner(
	opts: {
		executable?: string;
		/** Files the agent's commands must never read, such as the app's saved tokens. */
		protectedFiles?: string[];
	} = {}
): AgentRunner {
	return async (input) => {
		const { Codex } = await import('@openai/codex-sdk');
		const readOnly = !!input.mode && input.mode !== 'code';
		const policy = sandboxPolicy({
			cwd: input.cwd,
			protectedFiles: opts.protectedFiles ?? [],
			readOnly
		});
		const env = Object.fromEntries(
			Object.entries(withoutSecrets()).filter(
				(entry): entry is [string, string] => entry[1] !== undefined
			)
		);
		const codex = new Codex({
			codexPathOverride: opts.executable,
			// Without a key, Codex uses its own login (`codex login`).
			apiKey: input.apiKey ?? undefined,
			env,
			config: { developer_instructions: [guidance(input), SANDBOX_GUIDANCE].join('\n') },
			configOverrides: codexSandbox(policy)
		});
		const thread = codex.startThread({
			workingDirectory: input.cwd,
			model: input.model,
			approvalPolicy: 'never'
		});

		try {
			const { events } = await thread.runStreamed(input.instruction, { signal: input.signal });
			input.log({ kind: 'info', text: `Agent started with Codex (${input.model})` });
			let summary = '';
			for await (const event of events) {
				for (const entry of describeCodexEvent(event, input.cwd)) {
					if (entry.kind === 'assistant') summary = entry.text;
					input.log(entry);
				}
				if (event.type === 'turn.failed') throw codexError(event.error.message);
				if (event.type === 'error') throw codexError(event.message);
				if (event.type === 'turn.completed') {
					if (!summary)
						throw new EngineError('agent_failed', 'The agent stopped without a summary.');
					return { summary, costUsd: null, turns: null };
				}
			}
			throw new EngineError('agent_failed', 'The agent stopped without a result.');
		} catch (error) {
			if (input.signal.aborted) throw input.signal.reason;
			if (!(error instanceof EngineError) && error instanceof Error)
				throw codexError(error.message);
			throw error;
		}
	};
}
