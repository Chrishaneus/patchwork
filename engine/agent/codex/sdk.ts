import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import path from 'node:path';
import { EngineError, type LogEntry } from '#lib/engine/contract.js';
import { withoutSecrets } from '../../core/env.js';
import { guidance, sandboxGuidance, short, type AgentRunner } from '../runner.js';
import { sandboxPolicy } from '../sandbox.js';
import { codexError, codexSandbox, unwrap } from './index.js';

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

/**
 * The OpenAI agent through `@openai/codex-sdk` (`codex exec`), kept for reference: Patchwork
 * runs Codex's app-server instead (`createCodexAgentRunner`), because `codex exec` can't ask
 * before running a command outside the sandbox. The sandbox is the whole boundary here.
 */
export function createCodexSdkAgentRunner(
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
			config: { developer_instructions: [guidance(input), sandboxGuidance(false)].join('\n') },
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
