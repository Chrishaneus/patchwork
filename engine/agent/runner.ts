import type { LogEntry, Repository, ReviewAttribute, RunKind } from '#lib/engine/contract.js';

/** What every agent is told when its shell commands are sandboxed. */
export const SANDBOX_GUIDANCE = [
	'Shell commands run in a sandbox: they can write only inside this working copy and reach only',
	'package registries (npm, PyPI, crates.io and the like), not GitHub or GitLab. If a command',
	'fails because of that, say so in your summary rather than working around it.'
].join('\n');

const LONG_COMMANDS = [
	'Commands such as installs, builds and test runs can take several minutes and print nothing for',
	'a long time. Wait for them to finish instead of stopping or restarting them.'
].join('\n');

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

/** What the agent is told about its job, besides the instruction itself. */
export function guidance(input: AgentRunInput) {
	if (input.mode && input.mode !== 'code') {
		return [
			`You are working in a read-only copy of the repository "${input.repository.slug ?? input.repository.name}".`,
			'Read code and run commands (tests, searches) as needed, but do not modify, create or delete files,',
			'and do not commit or push. Follow the requested output format exactly.',
			LONG_COMMANDS
		].join('\n');
	}
	return [
		`You are working in an isolated git worktree of the repository "${input.repository.slug ?? input.repository.name}",`,
		`on the new branch "${input.branch}" created from "${input.baseBranch}".`,
		'Make the change the user asks for, following the conventions already used in the repository.',
		'Run the project’s existing checks or tests when that is practical, and fix what your change breaks.',
		'Do not commit, push, or open pull requests: the app does that after a person reviews your work.',
		'End with a short Markdown summary of what you changed and why. It becomes the pull request description,',
		'so do not add a signature or "generated with" footer to it.',
		LONG_COMMANDS
	].join('\n');
}

export const short = (value: unknown, max = 160) => {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
