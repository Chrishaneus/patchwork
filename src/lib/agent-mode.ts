/** What the Agent does with your first message. */
export type AgentMode = 'change' | 'review' | 'explore' | 'ask';

export const agentModes: AgentMode[] = ['change', 'ask', 'review', 'explore'];

/** Read `?mode=` from the Agent link; anything else means a change. */
export function parseAgentMode(value: string | null | undefined): AgentMode {
	return agentModes.includes(value as AgentMode) ? (value as AgentMode) : 'change';
}

/** The first GitHub pull request or GitLab merge request link in a message, if any. */
export function findPullRequestLink(text: string): string | null {
	const match = /https?:\/\/[^\s<>()]+?\/(?:pull|-\/merge_requests)\/\d+/i.exec(text);
	return match ? match[0] : null;
}

const REVIEW_REQUEST =
	/\b(review|check|look\s+(at|over)|audit|rate|critique)\b[\s\S]*\b(pr|prs|pull request|merge request|mr|![0-9]+|#[0-9]+)\b/i;
const EXPLORE_START =
	/^\s*(please\s+)?(explore|investigate|research|brainstorm|compare|evaluate|propose|suggest)\b/i;
const EXPLORE_ANYWHERE =
	/\b(how (could|should|would|can|might|do) (we|i|you)|what (are|would be) (some|the)?\s*(good\s+)?(options|ways|approaches|alternatives)|which approach|what approach|pros and cons|trade-?offs|options for|approaches (to|for)|ways to)\b/i;

const ASK = [
	/^\s*(hey[,!]?\s+)?(can|could|would) you\s+(please\s+)?(explain|describe|tell me|summari[sz]e|walk me through|show me|help me understand)\b/i,
	/^\s*(please\s+)?(explain|describe|summari[sz]e|tell me|walk me through|help me understand)\b/i,
	/^\s*(what|why|where|who|which|when)\b/i,
	/^\s*how (does|do|is|are|did|was|were)\b/i,
	/^\s*(is|are|does|do|did|has|have) (there|it|this|that|the|we|any)\b[^?]*\?\s*$/i
];

/**
 * Guess what a message asks for, so the Agent can pick the mode itself:
 * - a pull request link, or "review/check … PR #12" → review;
 * - "explore …", "how should we …", "what are the options …" → explore;
 * - a question about the code ("explain …", "what is …", "how does …") → ask;
 * - anything else → a change.
 */
export function detectAgentMode(text: string): AgentMode {
	if (!text.trim()) return 'change';
	if (findPullRequestLink(text) || REVIEW_REQUEST.test(text)) return 'review';
	if (EXPLORE_START.test(text) || EXPLORE_ANYWHERE.test(text)) return 'explore';
	if (ASK.some((pattern) => pattern.test(text))) return 'ask';
	return 'change';
}
