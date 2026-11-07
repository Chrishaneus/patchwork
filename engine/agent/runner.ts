import path from 'node:path';
import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
	EngineError,
	type LogEntry,
	type Repository,
	type ReviewAttribute,
	type RunKind
} from '#lib/engine/contract.js';
import { withoutSecrets } from '../core/env.js';
import { decideToolUse } from './policy.js';

/**
 * The environment for Claude Code: none of the app's tokens (the agent's shell commands inherit
 * it), only the Anthropic key the agent signs in with, when there is one.
 */
export function agentEnv(apiKey: string | null) {
	return withoutSecrets({
		CLAUDE_AGENT_SDK_CLIENT_APP: 'patchwork/0.0.1',
		...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {})
	});
}

/** The agent couldn't sign in to Anthropic (no API key and no Claude login). */
export function isSignInError(text: string) {
	return /not logged in|please run \/login|invalid api key|authentication_error|x-api-key/i.test(
		text
	);
}

/** The agent's failure, with a clear message when it simply has no Anthropic credentials. */
function agentError(text: string) {
	return isSignInError(text)
		? new EngineError(
				'agent_not_signed_in',
				'The agent has no Anthropic credentials. Add an API key in Settings → AI agent (or set ANTHROPIC_API_KEY), or sign in to Claude on this machine.'
			)
		: new EngineError('agent_failed', text);
}

export interface AgentRunInput {
	/** The worktree the agent works in. */
	cwd: string;
	instruction: string;
	repository: Repository;
	branch: string;
	baseBranch: string;
	model: string;
	/** Saved or environment API key; when null the agent's own login is used, if any. */
	apiKey: string | null;
	signal: AbortSignal;
	log: (entry: Omit<LogEntry, 'at'>) => void;
	/** The workflow: code (default) changes files; review and explore are read-only. */
	mode?: RunKind;
	/** Review workflow: the attributes asked for (so test agents can answer in shape). */
	attributes?: ReviewAttribute[];
}

export interface AgentRunOutput {
	summary: string;
	costUsd: number | null;
	turns: number | null;
}

/** Runs an AI agent in a worktree. Swappable so tests never call the real model. */
export type AgentRunner = (input: AgentRunInput) => Promise<AgentRunOutput>;

function guidance(input: AgentRunInput) {
	if (input.mode && input.mode !== 'code') {
		return [
			`You are working in a read-only copy of the repository "${input.repository.slug ?? input.repository.name}".`,
			'Read code and run commands (tests, searches) as needed, but do not modify, create or delete files,',
			'and do not commit or push. Follow the requested output format exactly.'
		].join('\n');
	}
	return [
		`You are working in an isolated git worktree of the repository "${input.repository.slug ?? input.repository.name}",`,
		`on the new branch "${input.branch}" created from "${input.baseBranch}".`,
		'Make the change the user asks for, following the conventions already used in the repository.',
		'Run the project’s existing checks or tests when that is practical, and fix what your change breaks.',
		'Do not commit, push, or open pull requests: the app does that after a person reviews your work.',
		'End with a short Markdown summary of what you changed and why. It becomes the pull request description,',
		'so do not add a signature or "generated with" footer to it.'
	].join('\n');
}

const short = (value: unknown, max = 160) => {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

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
export function describeMessage(message: SDKMessage, cwd: string): Omit<LogEntry, 'at'>[] {
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
export function createClaudeAgentRunner(opts: { executable?: string } = {}): AgentRunner {
	return async (input) => {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const abortController = new AbortController();
		const abort = () => abortController.abort();
		if (input.signal.aborted) abort();
		else input.signal.addEventListener('abort', abort, { once: true });

		const canUseTool: CanUseTool = async (toolName, toolInput) => {
			const decision = decideToolUse(
				toolName,
				toolInput,
				input.cwd,
				!!input.mode && input.mode !== 'code'
			);
			if (decision.allow) return { behavior: 'allow', updatedInput: toolInput };
			input.log({ kind: 'error', text: `Blocked ${toolName}: ${decision.reason}` });
			return { behavior: 'deny', message: decision.reason };
		};

		const env = agentEnv(input.apiKey);

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
					systemPrompt: { type: 'preset', preset: 'claude_code', append: guidance(input) },
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
				for (const entry of describeMessage(message, input.cwd)) {
					if (entry.kind === 'assistant') lastText = entry.text;
					input.log(entry);
				}
				if (message.type !== 'result') continue;

				if (message.subtype !== 'success') {
					throw agentError(message.errors.join('\n') || message.subtype);
				}
				if (message.is_error) throw agentError(message.result);
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
				isSignInError(error.message)
			) {
				throw agentError(error.message);
			}
			throw error;
		} finally {
			input.signal.removeEventListener('abort', abort);
		}
	};
}
