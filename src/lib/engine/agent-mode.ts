/** What the Agent does with your first message. */
export type AgentMode = 'change' | 'review' | 'explore' | 'ask';

export const agentModes: AgentMode[] = ['change', 'ask', 'review', 'explore'];

/** Read `?mode=` from the Agent link; anything else means a change. */
export function parseAgentMode(value: string | null | undefined): AgentMode {
	return agentModes.includes(value as AgentMode) ? (value as AgentMode) : 'change';
}

const PULL_REQUEST_LINK = /https?:\/\/[^\s<>()]+?\/(?:pull|-\/merge_requests)\/\d+/gi;

/** The first GitHub pull request or GitLab merge request link in a message, if any. */
export function findPullRequestLink(text: string): string | null {
	return findPullRequestLinks(text)[0] ?? null;
}

/** Every pull request or merge request link in a message, in order, each once. */
export function findPullRequestLinks(text: string): string[] {
	return [...new Set([...text.matchAll(PULL_REQUEST_LINK)].map((m) => m[0]))];
}

/** "Address the reviews", "fix the comments", "apply the suggestions": work on the pull request. */
const ADDRESS_REVIEW =
	/\b(address|fix|apply|resolve|handle|implement|incorporate|act on|respond to|tackle)\b[\s\S]*\b(reviews?|comments?|feedback|suggestions?|requested changes|changes requested)\b/i;

/** Whether a message with a pull request link asks to change it as its review asks. */
export function asksToAddressReview(text: string): boolean {
	return !!findPullRequestLink(text) && ADDRESS_REVIEW.test(text);
}

/**
 * The first pull request link with what points into it, such as #pullrequestreview-12 (one
 * review), #discussion_r34 (one thread) or GitLab's #note_56, which `findPullRequestLink` drops.
 */
export function findPullRequestTarget(text: string): string | null {
	const link = findPullRequestLink(text);
	if (!link) return null;
	const at = text.indexOf(link);
	const anchor = /^(?:\/[^\s#]*)?(#[\w-]+)/.exec(text.slice(at + link.length));
	return link + (anchor?.[1] ?? '');
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
 * - a pull request link with "address/fix … the review" → a change to that pull request;
 * - a pull request link, or "review/check … PR #12" → review;
 * - "explore …", "how should we …", "what are the options …" → explore;
 * - a question about the code ("explain …", "what is …", "how does …") → ask;
 * - anything else → a change.
 */
export function detectAgentMode(text: string): AgentMode {
	if (!text.trim()) return 'change';
	if (asksToAddressReview(text)) return 'change';
	if (findPullRequestLink(text) || REVIEW_REQUEST.test(text)) return 'review';
	if (EXPLORE_START.test(text) || EXPLORE_ANYWHERE.test(text)) return 'explore';
	if (ASK.some((pattern) => pattern.test(text))) return 'ask';
	return 'change';
}
