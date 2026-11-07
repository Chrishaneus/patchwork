import { describe, expect, it } from 'vitest';
import {
	isSignInError,
	reviewFocus,
	defaultReviewAttributes,
	extractJson,
	parseExploration,
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
			postedUrl: null
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
			verdict: 'request_changes',
			postedUrl: null
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

describe('isSignInError', () => {
	it('recognizes a missing login or bad key', () => {
		expect(isSignInError('Not logged in · Please run /login')).toBe(true);
		expect(isSignInError('Invalid API key · Fix external API key')).toBe(true);
		expect(isSignInError('Tool failed: file not found')).toBe(false);
	});
});
