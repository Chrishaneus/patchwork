import {
	agentModes,
	detectAgentMode,
	findPullRequestLink,
	type AgentMode
} from '#lib/agent-mode.js';
import { EngineError } from '#lib/engine/contract.js';

export interface ClassifyInput {
	text: string;
	/** Saved or environment API key; when null the agent's own login is used, if any. */
	apiKey: string | null;
	signal: AbortSignal;
}

/** Decides which workflow a first message asks for. Swappable so tests never call the real model. */
export type ModeClassifier = (input: ClassifyInput) => Promise<AgentMode>;

/** The keyword rules alone: the fallback, and the classifier end-to-end tests use. */
export const classifyByRules: ModeClassifier = async ({ text }) => detectAgentMode(text);

const INSTRUCTIONS = `You route messages in a coding tool. Read the user's message and decide which workflow it asks for:
- review: feedback on an existing pull request or merge request.
- ask: a question about how existing code works or why it is the way it is; the user wants an answer, not changes.
- explore: the user wants approaches, options or a plan compared before anything is built; no changes yet.
- change: the user wants code or files modified (fix, add, remove, refactor, rename, update, write tests, …).
When unsure between change and something else, answer change.
Reply with exactly one word: review, ask, explore or change.`;

/** The first mode name in the model's reply. */
export function parseMode(reply: string): AgentMode | null {
	const match = new RegExp(`\\b(${agentModes.join('|')})\\b`, 'i').exec(reply);
	return match ? (match[1].toLowerCase() as AgentMode) : null;
}

/** A small, fast Claude model with every tool turned off, for one short answer. */
export function createClaudeModeClassifier(
	opts: { executable?: string; model?: string } = {}
): ModeClassifier {
	return async ({ text, apiKey, signal }) => {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		const abortController = new AbortController();
		const abort = () => abortController.abort();
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });

		const env: Record<string, string | undefined> = {
			...process.env,
			CLAUDE_AGENT_SDK_CLIENT_APP: 'patchwork/0.0.1'
		};
		if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

		try {
			const session = query({
				prompt: `<message>\n${text}\n</message>`,
				options: {
					model: opts.model ?? 'claude-haiku-5-5',
					abortController,
					systemPrompt: INSTRUCTIONS,
					tools: [],
					maxTurns: 1,
					settingSources: [],
					persistSession: false,
					env,
					pathToClaudeCodeExecutable: opts.executable
				}
			});
			for await (const message of session) {
				if (message.type !== 'result') continue;
				if (message.subtype !== 'success' || message.is_error) break;
				const mode = parseMode(message.result);
				if (mode) return mode;
				break;
			}
			throw new EngineError('agent_failed', 'The model gave no mode.');
		} finally {
			signal.removeEventListener('abort', abort);
		}
	};
}

/** Long enough to read the intent; the rest of a long message doesn't change it. */
const MAX_CLASSIFY_CHARS = 4000;
const CLASSIFY_TIMEOUT_MS = 15_000;

/**
 * The engine's `classifyMessage`: the model decides, except for a pull request link (always a
 * review) or when it can't answer, where the keyword rules do.
 */
export function createMessageClassifier(opts: {
	classify: ModeClassifier;
	getApiKey: () => Promise<string | null>;
}) {
	return async ({ text }: { text: string }) => {
		if (typeof text !== 'string') throw new EngineError('invalid_input', 'Write a message.');
		const message = text.trim().slice(0, MAX_CLASSIFY_CHARS);
		if (!message || findPullRequestLink(message)) {
			return { mode: detectAgentMode(message), source: 'rules' as const };
		}
		try {
			const mode = await opts.classify({
				text: message,
				apiKey: await opts.getApiKey(),
				signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
			});
			return { mode, source: 'ai' as const };
		} catch {
			return { mode: detectAgentMode(message), source: 'rules' as const };
		}
	};
}
