import {
	EngineError,
	type Approach,
	type Exploration,
	type PullRequestReview,
	type ReviewAttribute,
	type ReviewComment,
	type ReviewedPullRequest,
	type ReviewResult,
	type ReviewScore,
	type ReviewVerdict
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

/** At most this many inline comments per pull request. */
export const MAX_COMMENTS = 15;

const COMMENT_RULES = [
	`Also leave inline comments (at most ${MAX_COMMENTS} per pull request) where something specific should change, preferring lines the pull request changes. Each names a file (relative to its repository's root), the lines in the pull request's version of it, and what to change.`,
	'When you can, include a suggestion: the exact replacement for those lines, indented as the file is, and nothing else. It replaces lines startLine to line entirely, so include every line of that range you want to keep. Leave suggestion out for a remark without code. Read the lines first so the numbers are right.'
].join(' ');

const COMMENT_SHAPE =
	'{"path": "src/file.ts", "startLine": 10, "line": 12, "body": "why", "suggestion": "replacement code"}';

const SCORES_SHAPE =
	'"scores": [{"attribute": "<name exactly as listed>", "score": 1-5, "explanation": "..."}]';

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
		COMMENT_RULES,
		JSON_RULE,
		`Shape: {${SCORES_SHAPE}, "summary": "overall assessment in a few sentences", "verdict": "approve" | "comment" | "request_changes", "comments": [${COMMENT_SHAPE}]}`
	].join('\n\n');
}

/** One pull request of several, with the folder its working copy is in. */
export interface PullRequestInFolder {
	pullRequest: ReviewedPullRequest;
	/** The folder, relative to the agent's working directory. */
	folder: string;
	repository: string;
	baseCommit: string;
}

/**
 * Several related pull requests, such as a change split up or stacked to be easier to review,
 * possibly in different repositories: each in its own folder, reviewed on its own and together.
 */
export function multiReviewPrompt(
	pulls: PullRequestInFolder[],
	attributes: ReviewAttribute[],
	focus?: string
) {
	const list = attributes.map((a) => `- ${a.name}: ${a.description}`).join('\n');
	const prs = pulls
		.map(
			({ pullRequest: pr, folder, repository, baseCommit }) =>
				`- ${pr.url} in \`${folder}\`: #${pr.number} "${pr.title}" in ${repository}, ${pr.headRef} into ${pr.baseRef}. Its changes: \`git -C ${folder} diff ${baseCommit}...HEAD\`.`
		)
		.join('\n');
	return [
		`Review these ${pulls.length} related pull requests together. They belong to one piece of work, split up or stacked to be easier to review, and may be in different repositories. Each one's working copy is checked out at its head in its own folder here:\n${prs}`,
		...(focus ? [`The person asking adds: ${focus}`] : []),
		'Read each diff and whatever surrounding code you need. You may run read-only commands and the tests. Do not change any files: this is a review.',
		'Review each pull request on its own, and the set as a whole: whether they fit together (the order they must merge in, interfaces and contracts between them, versions), whether anything is missing, duplicated or in the wrong one, and whether each still works if merged without the others.',
		`Rate each pull request, and the set as a whole, from 1 (poor) to 5 (excellent) on each of these attributes:\n${list}`,
		'Explain each score briefly and concretely. If an attribute does not apply, give it 5 and say why.',
		COMMENT_RULES +
			' Comments belong to the pull request whose files they are on; paths are relative to that repository, without the folder.',
		JSON_RULE,
		`Shape: {${SCORES_SHAPE} (the set as a whole), "summary": "how the pull requests fit together, in a few sentences", "verdict": "approve" | "comment" | "request_changes", "pullRequests": [{"url": "<its link exactly as listed>", ${SCORES_SHAPE}, "summary": "...", "verdict": "...", "comments": [${COMMENT_SHAPE}]}] (one per pull request, in the order listed)}`
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

/** One score per requested attribute, 1–5; `of` names what was rated, for errors. */
function parseScores(
	raw: unknown,
	attributes: ReviewAttribute[],
	of = 'The review'
): ReviewScore[] {
	const given = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
	return attributes.map((attribute) => {
		const match = given.find(
			(s) => str(s?.attribute).toLowerCase() === attribute.name.toLowerCase()
		);
		if (!match) {
			throw new EngineError('unreadable_result', `${of} has no score for "${attribute.name}".`);
		}
		const score = Math.round(Number(match.score));
		if (!Number.isFinite(score)) {
			throw new EngineError(
				'unreadable_result',
				`${of}: the score for "${attribute.name}" is not a number.`
			);
		}
		return {
			attribute: attribute.name,
			score: Math.min(5, Math.max(1, score)),
			explanation: str(match.explanation)
		};
	});
}

const parseVerdict = (v: unknown): ReviewVerdict =>
	['approve', 'comment', 'request_changes'].includes(str(v))
		? (str(v) as ReviewVerdict)
		: 'comment';

const positiveInt = (v: unknown) => {
	const n = Number(v);
	return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * The agent's inline comments, checked: a relative path inside the repository, sensible lines,
 * and something to say. Broken ones are left out rather than failing the review. The lines'
 * text and whether they're in the diff are filled in later, from the working copy.
 */
export function parseComments(raw: unknown): ReviewComment[] {
	if (!Array.isArray(raw)) return [];
	const comments: ReviewComment[] = [];
	for (const item of raw as Record<string, unknown>[]) {
		const path = str(item?.path)
			.replace(/\\/g, '/')
			.replace(/^(\.\/)+/, '');
		if (!path || path.startsWith('/') || path.split('/').includes('..')) continue;
		const line = positiveInt(item.line);
		if (!line) continue;
		const startLine = Math.min(positiveInt(item.startLine) ?? line, line);
		const suggestion =
			typeof item.suggestion === 'string' ? item.suggestion.replace(/\n$/, '') : null;
		const body = str(item.body);
		if (!body && suggestion === null) continue;
		comments.push({ path, startLine, line, body, suggestion, original: null, inDiff: false });
		if (comments.length === MAX_COMMENTS) break;
	}
	return comments;
}

/** Read and check the agent's review of one pull request: one score per attribute, 1–5. */
export function parseReview(text: string, attributes: ReviewAttribute[]): ReviewResult {
	const data = extractJson(text) as Record<string, unknown>;
	return {
		scores: parseScores(data.scores, attributes),
		summary: str(data.summary),
		verdict: parseVerdict(data.verdict),
		postedUrl: null,
		comments: parseComments(data.comments)
	};
}

/**
 * Read and check the agent's review of several pull requests: the set as a whole, and one review
 * per pull request, matched by link (or else by position).
 */
export function parseMultiReview(
	text: string,
	attributes: ReviewAttribute[],
	pulls: ReviewedPullRequest[]
): ReviewResult {
	const data = extractJson(text) as Record<string, unknown>;
	const given = Array.isArray(data.pullRequests)
		? (data.pullRequests as Record<string, unknown>[])
		: [];
	// By link first, then by number, then whatever is left, in order.
	const matched = new Map<ReviewedPullRequest, Record<string, unknown>>();
	const free = new Set(given);
	const claim = (find: (pr: ReviewedPullRequest) => Record<string, unknown> | undefined) => {
		for (const pr of pulls) {
			if (matched.has(pr)) continue;
			const entry = find(pr);
			if (entry) {
				matched.set(pr, entry);
				free.delete(entry);
			}
		}
	};
	claim((pr) => [...free].find((g) => str(g?.url) === pr.url));
	claim((pr) => [...free].find((g) => !str(g?.url) && Number(g?.number) === pr.number));
	// A link the agent got wrong still counts by its place.
	claim(() => [...free][0]);
	const pullRequests: PullRequestReview[] = pulls.map((pr) => {
		const entry = matched.get(pr);
		if (!entry) {
			throw new EngineError('unreadable_result', `The review has nothing on ${pr.url}.`);
		}
		return {
			url: pr.url,
			number: pr.number,
			title: pr.title,
			provider: pr.provider,
			scores: parseScores(entry.scores, attributes, `The review of #${pr.number}`),
			summary: str(entry.summary),
			verdict: parseVerdict(entry.verdict),
			comments: parseComments(entry.comments),
			headSha: null,
			postedUrl: null
		};
	});
	return {
		scores: parseScores(data.scores, attributes, 'The review of the set'),
		summary: str(data.summary),
		verdict: parseVerdict(data.verdict),
		postedUrl: null,
		pullRequests
	};
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

/** A fence longer than any run of backticks in `code`, so the code can't close it. */
function fence(code: string) {
	const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
	return '`'.repeat(longest + 1);
}

const lines = (c: ReviewComment) =>
	c.startLine === c.line ? `line ${c.line}` : `lines ${c.startLine}–${c.line}`;

/**
 * An inline comment's text: the remark, then the suggestion in the provider's syntax. GitHub
 * replaces the commented range; GitLab counts the lines above the commented one.
 */
export function inlineCommentMarkdown(c: ReviewComment, provider: 'github' | 'gitlab'): string {
	if (c.suggestion === null) return c.body;
	const f = fence(c.suggestion);
	const tag = provider === 'gitlab' ? `suggestion:-${c.line - c.startLine}+0` : 'suggestion';
	return [c.body, `${f}${tag}\n${c.suggestion}\n${f}`].filter(Boolean).join('\n\n');
}

/** Comments that couldn't go inline, for the review's main comment. */
function commentsSection(comments: ReviewComment[]): string {
	if (comments.length === 0) return '';
	return [
		'#### Comments',
		...comments.map((c) => {
			const head = `**\`${c.path}\`**, ${lines(c)}${c.body ? `: ${c.body}` : ''}`;
			if (c.suggestion === null) return head;
			const f = fence(c.suggestion);
			return `${head}\n\nSuggested:\n\n${f}\n${c.suggestion}\n${f}`;
		})
	].join('\n\n');
}

/**
 * The review as a Markdown comment for GitHub or GitLab. `notInline` are the comments that
 * couldn't be posted on their lines; `together` names the other pull requests of a set.
 */
export function reviewMarkdown(
	review: Pick<ReviewResult, 'scores' | 'summary' | 'verdict'>,
	opts: { notInline?: ReviewComment[]; together?: { set: string; others: string[] } } = {}
): string {
	const rows = review.scores
		.map(
			(s) =>
				`| ${s.attribute} | ${'★'.repeat(s.score)}${'☆'.repeat(5 - s.score)} ${s.score}/5 | ${s.explanation.replace(/\|/g, '\\|').replace(/\n+/g, ' ')} |`
		)
		.join('\n');
	return [
		`### Review: ${verdictLabel[review.verdict]}`,
		opts.together &&
			`Reviewed together with ${opts.together.others.join(', ')}. ${opts.together.set}`.trim(),
		review.summary,
		'| Attribute | Score | Notes |\n| --- | --- | --- |\n' + rows,
		commentsSection(opts.notInline ?? []),
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
