import { describe, expect, it } from 'vitest';
import type { ReviewComment, ReviewedPullRequest } from '#lib/engine/contract.js';
import {
	reviewFocus,
	defaultReviewAttributes,
	extractJson,
	inlineCommentMarkdown,
	multiReviewPrompt,
	parseComments,
	parseExploration,
	parseMultiReview,
	parsePullRequestUrl,
	parseReview,
	reviewMarkdown
} from './workflows';

const attrs = defaultReviewAttributes.slice(0, 2); // Correctness, Security

describe('reading the agent output', () => {
	it('takes the last json block, or else the last object', () => {
		expect(extractJson('Thinking…\n```json\n{"a":1}\n```\nMore\n```json\n{"a":2}\n```')).toEqual({
			a: 2
		});
		expect(extractJson('Here you go: {"b": true}')).toEqual({ b: true });
		expect(() => extractJson('no json here')).toThrow(/expected JSON/);
	});

	it('reads a review, clamps scores to 1–5, and needs every attribute', () => {
		const text =
			'Review done.\n```json\n{"scores":[{"attribute":"correctness","score":4,"explanation":"Good."},{"attribute":"Security","score":9,"explanation":"Fine."}],"summary":"Solid.","verdict":"approve"}\n```';
		expect(parseReview(text, attrs)).toEqual({
			scores: [
				{ attribute: 'Correctness', score: 4, explanation: 'Good.' },
				{ attribute: 'Security', score: 5, explanation: 'Fine.' }
			],
			summary: 'Solid.',
			verdict: 'approve',
			postedUrl: null,
			comments: []
		});
		expect(() => parseReview('```json\n{"scores":[]}\n```', attrs)).toThrow(
			/no score for "Correctness"/
		);
	});

	it('reads an exploration and normalises unknown values', () => {
		const text =
			'```json\n{"approaches":[{"title":"Cache it","summary":"s","details":"d","files":["a.ts"],"pros":["fast"],"cons":[],"effort":"huge"}],"recommendation":"Cache it."}\n```';
		expect(parseExploration(text)).toEqual({
			approaches: [
				{
					title: 'Cache it',
					summary: 's',
					details: 'd',
					files: ['a.ts'],
					pros: ['fast'],
					cons: [],
					effort: 'medium'
				}
			],
			recommendation: 'Cache it.'
		});
		expect(() => parseExploration('```json\n{"approaches":[]}\n```')).toThrow(/no approaches/);
	});
});

describe('pull request links', () => {
	it('understands GitHub and GitLab links', () => {
		expect(parsePullRequestUrl('https://github.com/acme/widgets/pull/12/files')).toEqual({
			provider: 'github',
			host: 'github.com',
			slug: 'acme/widgets',
			number: 12
		});
		expect(parsePullRequestUrl('https://gitlab.com/acme/platform/api/-/merge_requests/7')).toEqual({
			provider: 'gitlab',
			host: 'gitlab.com',
			slug: 'acme/platform/api',
			number: 7
		});
		expect(() => parsePullRequestUrl('https://github.com/acme/widgets')).toThrow(
			/pull request link/
		);
	});
});

describe('review comment', () => {
	it('renders scores as a table', () => {
		const md = reviewMarkdown({
			scores: [{ attribute: 'Security', score: 3, explanation: 'Input | not escaped' }],
			summary: 'Mostly fine.',
			verdict: 'request_changes'
		});
		expect(md).toContain('### Review: Request changes');
		expect(md).toContain('| Security | ★★★☆☆ 3/5 | Input \\| not escaped |');
	});
});

describe('reviewFocus', () => {
	it('keeps only what to focus on', () => {
		const link = 'https://github.com/acme/api/pull/12';
		expect(reviewFocus(`review ${link}`)).toBeUndefined();
		expect(reviewFocus(`Please review this PR: ${link}`)).toBeUndefined();
		expect(reviewFocus(link)).toBeUndefined();
		expect(reviewFocus(`review ${link} and focus on error handling`)).toBe(
			'focus on error handling'
		);
		expect(reviewFocus(`${link} is the SQL safe?`)).toBe('is the SQL safe');
		expect(reviewFocus(undefined)).toBeUndefined();
	});
});

const pr = (number: number, repo = 'acme/api'): ReviewedPullRequest => ({
	provider: 'github',
	url: `https://github.com/${repo}/pull/${number}`,
	number,
	title: `Part ${number}`,
	baseRef: 'main',
	headRef: `part-${number}`
});

const scores =
	'[{"attribute":"Correctness","score":4,"explanation":"ok"},{"attribute":"Security","score":5,"explanation":"ok"}]';

describe('inline comments', () => {
	it('keeps sensible comments and drops broken ones', () => {
		expect(
			parseComments([
				{
					path: './src/a.ts',
					startLine: 3,
					line: 4,
					body: 'Use const',
					suggestion: 'const a = 1;\n'
				},
				{ path: 'src/b.ts', line: 7, body: 'Why?' },
				{ path: '../etc/passwd', line: 1, body: 'escape' },
				{ path: '/abs.ts', line: 1, body: 'absolute' },
				{ path: 'src/c.ts', line: 0, body: 'no line' },
				{ path: 'src/d.ts', line: 2 },
				{ path: 'src/e.ts', startLine: 9, line: 5, suggestion: '' }
			])
		).toEqual([
			{
				path: 'src/a.ts',
				startLine: 3,
				line: 4,
				body: 'Use const',
				suggestion: 'const a = 1;',
				original: null,
				inDiff: false
			},
			{
				path: 'src/b.ts',
				startLine: 7,
				line: 7,
				body: 'Why?',
				suggestion: null,
				original: null,
				inDiff: false
			},
			// A start after the end is read as one line; an empty suggestion deletes it.
			{
				path: 'src/e.ts',
				startLine: 5,
				line: 5,
				body: '',
				suggestion: '',
				original: null,
				inDiff: false
			}
		]);
		expect(parseComments('nope')).toEqual([]);
	});

	it('writes suggestions in GitHub’s and GitLab’s syntax, fenced past any backticks', () => {
		const c: ReviewComment = {
			path: 'a.md',
			startLine: 2,
			line: 4,
			body: 'Tidy this.',
			suggestion: 'Use ```code``` here',
			original: null,
			inDiff: true
		};
		expect(inlineCommentMarkdown(c, 'github')).toBe(
			'Tidy this.\n\n````suggestion\nUse ```code``` here\n````'
		);
		expect(inlineCommentMarkdown(c, 'gitlab')).toBe(
			'Tidy this.\n\n````suggestion:-2+0\nUse ```code``` here\n````'
		);
		expect(inlineCommentMarkdown({ ...c, suggestion: null }, 'github')).toBe('Tidy this.');
	});

	it('puts comments that can’t go inline, and the other pull requests, in the main comment', () => {
		const text = reviewMarkdown(
			{
				scores: [{ attribute: 'Correctness', score: 4, explanation: 'ok' }],
				summary: 'Fine.',
				verdict: 'comment'
			},
			{
				notInline: [
					{
						path: 'src/a.ts',
						startLine: 1,
						line: 1,
						body: 'Rename',
						suggestion: 'const b = 1;',
						original: null,
						inDiff: false
					}
				],
				together: { set: 'They fit.', others: ['https://github.com/acme/web/pull/3'] }
			}
		);
		expect(text).toContain('Reviewed together with https://github.com/acme/web/pull/3. They fit.');
		expect(text).toContain('**`src/a.ts`**, line 1: Rename');
		expect(text).toContain('```\nconst b = 1;\n```');
	});
});

describe('reviewing several pull requests', () => {
	it('lists each with its folder and diff, and asks how they fit together', () => {
		const prompt = multiReviewPrompt(
			[
				{ pullRequest: pr(1), folder: 'api-1', repository: 'acme/api', baseCommit: 'aaa' },
				{
					pullRequest: pr(3, 'acme/web'),
					folder: 'web-3',
					repository: 'acme/web',
					baseCommit: 'bbb'
				}
			],
			attrs,
			'check the API contract'
		);
		expect(prompt).toContain('- https://github.com/acme/api/pull/1 in `api-1`');
		expect(prompt).toContain('`git -C web-3 diff bbb...HEAD`');
		expect(prompt).toContain('check the API contract');
		expect(prompt).toMatch(/fit together/);
	});

	it('reads the set and each pull request, matched by link or else by position', () => {
		const text = `\`\`\`json
{"scores": ${scores}, "summary": "They fit.", "verdict": "comment", "pullRequests": [
  {"url": "https://github.com/acme/web/pull/3", "scores": ${scores}, "summary": "Web side.", "verdict": "approve",
   "comments": [{"path": "src/app.ts", "line": 2, "body": "x", "suggestion": "y"}]},
  {"scores": ${scores}, "summary": "API side.", "verdict": "request_changes"}
]}
\`\`\``;
		const review = parseMultiReview(text, attrs, [pr(1), pr(3, 'acme/web')]);
		expect(review).toMatchObject({ summary: 'They fit.', verdict: 'comment', postedUrl: null });
		expect(review.pullRequests).toMatchObject([
			{ number: 1, summary: 'API side.', verdict: 'request_changes', comments: [] },
			{ number: 3, summary: 'Web side.', verdict: 'approve', comments: [{ path: 'src/app.ts' }] }
		]);
		expect(() =>
			parseMultiReview(`\`\`\`json\n{"scores": ${scores}, "pullRequests": []}\n\`\`\``, attrs, [
				pr(1)
			])
		).toThrow(/nothing on https:\/\/github.com\/acme\/api\/pull\/1/);
	});
});
