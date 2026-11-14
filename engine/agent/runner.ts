import type { LogEntry, Repository, ReviewAttribute, RunKind } from '#lib/engine/contract.js';

/**
 * What every agent is told when its shell commands are sandboxed; `canAsk` when it can ask the
 * user to run one command outside the sandbox (`requestApproval`).
 */
export function sandboxGuidance(canAsk: boolean) {
	return [
		'Shell commands run in a sandbox: they can write only inside this working copy and reach only',
		'package registries (npm, PyPI, crates.io and the like), not GitHub or GitLab.',
		canAsk
			? 'If a command the task really needs fails because of that, you may ask to run that one command outside the sandbox: the user sees the exact command and decides. Ask only when there is no way inside the sandbox, never to push, open pull requests or reach the GitHub or GitLab APIs, and say why in one sentence. If the user declines, carry on without it and mention it in your summary.'
			: 'If a command fails because of that, say so in your summary rather than working around it.'
	].join('\n');
}

/**
 * How a change's last message is written: the pull request's title and description, which the
 * app reads (`splitTitle` in runs/code-task.ts) and offers when publishing.
 */
export const PULL_REQUEST_FORMAT = [
	'Your last message is the pull request for your change, and nothing else. Its first line is "Title: " and the',
	'title: what the change does, under 72 characters, in the style of the repository’s recent commit subjects',
	'(see `git log --format=%s -15`). Then a blank line and the description in Markdown, written for the reviewer',
	'rather than as a reply to the user: what changed and why, and how you checked it. No signature or',
	'"generated with" footer.'
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
	/**
	 * Ask the user to let one command run outside the sandbox; resolves to whether they allowed
	 * it. Runners call it when their agent asks; missing when nobody can answer.
	 */
	requestApproval?: (request: { command: string; reason: string | null }) => Promise<boolean>;
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
		PULL_REQUEST_FORMAT,
		LONG_COMMANDS
	].join('\n');
}

export const short = (value: unknown, max = 160) => {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
