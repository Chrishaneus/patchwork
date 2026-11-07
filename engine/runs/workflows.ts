import {
	EngineError,
	type Approach,
	type Exploration,
	type ReviewAttribute,
	type ReviewedPullRequest,
	type ReviewResult
} from '#lib/engine/contract.js';

/** What a review rates by default; editable in Settings and per review. */
export const defaultReviewAttributes: ReviewAttribute[] = [
	{
		id: 'correctness',
		name: 'Correctness',
		description: 'Does what it sets out to do, without bugs, regressions or unhandled edge cases.'
	},
	{
		id: 'security',
		name: 'Security',
		description:
			'No injection, unsafe input handling, leaked secrets, broken auth or risky dependencies.'
	},
	{
		id: 'minimalism',
		name: 'Minimalism',
		description:
			'The smallest change that solves the problem: no unrelated edits, dead code or over-engineering.'
	},
	{
		id: 'readability',
		name: 'Readability',
		description:
			'Clear names and structure, follows the codebase conventions, comments where they help.'
	},
	{
		id: 'tests',
		name: 'Tests',
		description: 'New and changed behaviour is covered by meaningful tests.'
	},
	{
		id: 'performance',
		name: 'Performance',
		description: 'No needless slowdowns, extra queries, memory or network use.'
	}
];

const JSON_RULE =
	'End your reply with exactly one fenced ```json code block containing only the JSON described below — no comments in it.';

export function reviewPrompt(
	pr: ReviewedPullRequest,
	attributes: ReviewAttribute[],
	baseCommit: string,
	focus?: string
) {
	const list = attributes.map((a) => `- ${a.name}: ${a.description}`).join('\n');
	return [
		`Review pull request #${pr.number}: "${pr.title}" (${pr.url}).`,
		...(focus ? [`The person asking adds: ${focus}`] : []),
		`The working copy is checked out at the pull request's head. Its changes are \`git diff ${baseCommit}...HEAD\` (the PR's commits on top of ${pr.baseRef}).`,
		'Read the diff and whatever surrounding code you need to understand it. You may run read-only commands and the tests. Do not change any files: this is a review.',
		`Rate the change from 1 (poor) to 5 (excellent) on each of these attributes:\n${list}`,
		'For each attribute, explain the score briefly and concretely, citing files and lines where it helps. If an attribute does not apply to this change, give it 5 and say why.',
		JSON_RULE,
		'Shape: {"scores": [{"attribute": "<name exactly as listed>", "score": 1-5, "explanation": "..."}], "summary": "overall assessment in a few sentences", "verdict": "approve" | "comment" | "request_changes"}'
	].join('\n\n');
}

export function explorePrompt(idea: string) {
	return [
		`Explore how this could be implemented in this repository: ${idea}`,
		'Study the codebase first. This is research only: do not change any files.',
		'Come up with 2 to 4 genuinely different approaches. For each: how it works, the files it would touch, its pros and cons, and the effort (small, medium or large). Then recommend one and say why.',
		JSON_RULE,
		'Shape: {"approaches": [{"title": "...", "summary": "one sentence", "details": "how it works", "files": ["path", ...], "pros": ["..."], "cons": ["..."], "effort": "small" | "medium" | "large"}], "recommendation": "which approach and why"}'
	].join('\n\n');
}

/** The agent's final JSON: the last ```json block, or else the last {...} object in the text. */
export function extractJson(text: string): unknown {
	const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
	const candidates = blocks.length > 0 ? [blocks.at(-1)![1]] : [];
	const lastBrace = text.lastIndexOf('}');
	const firstBrace = text.indexOf('{');
	if (firstBrace !== -1 && lastBrace > firstBrace)
		candidates.push(text.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate.trim());
		} catch {
			// Try the next candidate.
		}
	}
	throw new EngineError('unreadable_result', 'The agent did not end with the expected JSON block.');
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** Read and check the agent's review: one score per requested attribute, 1–5. */
export function parseReview(text: string, attributes: ReviewAttribute[]): ReviewResult {
	const data = extractJson(text) as { scores?: unknown; summary?: unknown; verdict?: unknown };
	const given = Array.isArray(data.scores) ? (data.scores as Record<string, unknown>[]) : [];
	const scores = attributes.map((attribute) => {
		const match = given.find(
			(s) => str(s.attribute).toLowerCase() === attribute.name.toLowerCase()
		);
		if (!match) {
			throw new EngineError(
				'unreadable_result',
				`The review has no score for "${attribute.name}".`
			);
		}
		const score = Math.round(Number(match.score));
		if (!Number.isFinite(score)) {
			throw new EngineError(
				'unreadable_result',
				`The score for "${attribute.name}" is not a number.`
			);
		}
		return {
			attribute: attribute.name,
			score: Math.min(5, Math.max(1, score)),
			explanation: str(match.explanation)
		};
	});
	const verdict = ['approve', 'comment', 'request_changes'].includes(str(data.verdict))
		? (str(data.verdict) as ReviewResult['verdict'])
		: 'comment';
	return { scores, summary: str(data.summary), verdict, postedUrl: null };
}

/** Read and check the agent's exploration: 1–4 approaches and a recommendation. */
export function parseExploration(text: string): Exploration {
	const data = extractJson(text) as { approaches?: unknown; recommendation?: unknown };
	const approaches: Approach[] = (Array.isArray(data.approaches) ? data.approaches : [])
		.slice(0, 4)
		.map((raw: Record<string, unknown>) => ({
			title: str(raw.title),
			summary: str(raw.summary),
			details: str(raw.details),
			files: strList(raw.files),
			pros: strList(raw.pros),
			cons: strList(raw.cons),
			effort: (['small', 'medium', 'large'].includes(str(raw.effort))
				? str(raw.effort)
				: 'medium') as Approach['effort']
		}))
		.filter((a) => a.title);
	if (approaches.length === 0) {
		throw new EngineError('unreadable_result', 'The exploration has no approaches.');
	}
	return { approaches, recommendation: str(data.recommendation) };
}

const verdictLabel = { approve: 'Approve', comment: 'Comment', request_changes: 'Request changes' };

/** The review as a Markdown comment for GitHub or GitLab. */
export function reviewMarkdown(review: ReviewResult): string {
	const rows = review.scores
		.map(
			(s) =>
				`| ${s.attribute} | ${'★'.repeat(s.score)}${'☆'.repeat(5 - s.score)} ${s.score}/5 | ${s.explanation.replace(/\|/g, '\\|').replace(/\n+/g, ' ')} |`
		)
		.join('\n');
	return [
		`### Review: ${verdictLabel[review.verdict]}`,
		review.summary,
		'| Attribute | Score | Notes |\n| --- | --- | --- |\n' + rows,
		'_Reviewed with Patchwork._'
	]
		.filter(Boolean)
		.join('\n\n');
}

/** A pull request URL: GitHub (…/owner/repo/pull/12) or GitLab (…/group/project/-/merge_requests/7). */
export function parsePullRequestUrl(url: string): {
	provider: 'github' | 'gitlab';
	host: string;
	slug: string;
	number: number;
} {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new EngineError(
			'invalid_pull_request',
			'Enter a pull request link, like https://github.com/owner/repo/pull/12.'
		);
	}
	const path = parsed.pathname.replace(/\/+$/, '');
	const gitlab = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(path);
	if (gitlab)
		return { provider: 'gitlab', host: parsed.host, slug: gitlab[1], number: Number(gitlab[2]) };
	const github = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(path);
	if (github)
		return { provider: 'github', host: parsed.host, slug: github[1], number: Number(github[2]) };
	throw new EngineError(
		'invalid_pull_request',
		'Enter a pull request link, like https://github.com/owner/repo/pull/12.'
	);
}

/** Check and tidy review attributes from the UI: names required, ids unique, at most 12. */
export function cleanAttributes(input: unknown): ReviewAttribute[] {
	if (!Array.isArray(input) || input.length === 0) {
		throw new EngineError('invalid_input', 'Choose at least one thing to rate.');
	}
	if (input.length > 12) throw new EngineError('invalid_input', 'Rate at most 12 things at once.');
	const seen = new Set<string>();
	return input.map((raw) => {
		const a = (raw ?? {}) as Partial<ReviewAttribute>;
		const name = typeof a.name === 'string' ? a.name.trim().slice(0, 60) : '';
		if (!name) throw new EngineError('invalid_input', 'Every attribute needs a name.');
		const description = typeof a.description === 'string' ? a.description.trim().slice(0, 500) : '';
		let id =
			(typeof a.id === 'string' && a.id.trim()) ||
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '') ||
			'attribute';
		while (seen.has(id)) id += '-2';
		seen.add(id);
		return { id, name, description };
	});
}

/**
 * A follow-up question on a finished review or exploration. The agent starts over in a fresh
 * read-only copy, so it gets the original task, its earlier answer and the conversation so far.
 */
export function readOnlyFollowUpPrompt(
	original: string,
	previous: unknown,
	earlier: string[],
	question: string
) {
	return [
		original,
		`You already did this. Your answer was:\n\n\`\`\`json\n${JSON.stringify(previous, null, 2)}\n\`\`\``,
		...(earlier.length
			? [`Earlier follow-up questions:\n${earlier.map((q) => `- ${q}`).join('\n')}`]
			: []),
		`Now the person asks: ${question}`,
		'Answer them directly in a few sentences first (look at the code again if needed; still change no files). Then, as before, end with the complete JSON in the same shape, updated if your assessment changed and unchanged otherwise.'
	].join('\n\n');
}

/**
 * What the person asked a review to focus on: their message without the pull request link and
 * without the request itself ("review this PR"). Null when nothing else is left.
 */
export function reviewFocus(message: string | undefined): string | undefined {
	const rest = (message ?? '')
		.replace(/https?:\/\/\S+?\/(?:pull|-\/merge_requests)\/\d+\S*/gi, ' ')
		.replace(
			/^\s*(can you\s+|could you\s+)?(please\s+)?(review|check|look\s+(at|over)|audit)(\s+(this|the|my|that))?(\s+(pr|pull request|merge request|mr))?(\s*(,|:|-|and|please))*/i,
			''
		)
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[,.:;!?-]+|[,.:;!?-]+$/g, '')
		.trim();
	return rest || undefined;
}

export function askPrompt(question: string) {
	return [
		question,
		'Answer from this repository: read the code (and run read-only commands) as needed. This is a question, not a change: do not modify any files.',
		'Answer in Markdown, concisely, pointing to the relevant files.'
	].join('\n\n');
}

/** A follow-up question in an Ask conversation: the earlier exchange, then the new question. */
export function askFollowUpPrompt(
	question: string,
	answer: string,
	earlier: string[],
	followUp: string
) {
	return [
		`Earlier you were asked about this repository:\n\n${question}`,
		...(earlier.length ? [`Then:\n${earlier.map((q) => `- ${q}`).join('\n')}`] : []),
		`Your latest answer was:\n\n${answer}`,
		`Now: ${followUp}`,
		'Answer from the code, read-only, in Markdown. Do not modify any files.'
	].join('\n\n');
}
