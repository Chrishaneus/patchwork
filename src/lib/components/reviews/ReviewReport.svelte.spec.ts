import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type {
	PullRequestReview,
	ReviewComment,
	ReviewedPullRequest,
	ReviewResult
} from '#lib/engine/contract.js';
import ReviewReport from './ReviewReport.svelte';

const scores = [{ attribute: 'Correctness', score: 4, explanation: 'Mostly right.' }];
const comment: ReviewComment = {
	path: 'src/app.ts',
	startLine: 3,
	line: 4,
	body: 'Use a **constant**.',
	suggestion: 'const LIMIT = 10;',
	original: 'let limit = 10;\nlimit = 10;',
	inDiff: true
};
const pullRequest: ReviewedPullRequest = {
	provider: 'github',
	url: 'https://github.com/acme/api/pull/1',
	number: 1,
	title: 'API part',
	baseRef: 'main',
	headRef: 'api'
};
const part = (number: number, repo: string, over: Partial<PullRequestReview> = {}) => ({
	url: `https://github.com/acme/${repo}/pull/${number}`,
	number,
	title: `${repo} part`,
	provider: 'github' as const,
	scores,
	summary: `${repo} side.`,
	verdict: 'comment' as const,
	comments: [],
	headSha: 'abc',
	postedUrl: null,
	...over
});

describe('ReviewReport.svelte', () => {
	it('shows suggestions as a diff of the lines and what they should become', async () => {
		const review: ReviewResult = {
			scores,
			summary: 'Fine.',
			verdict: 'comment',
			postedUrl: null,
			comments: [
				comment,
				{
					...comment,
					path: 'docs/a.md',
					line: 9,
					startLine: 9,
					inDiff: false,
					suggestion: null,
					body: 'Typo.'
				}
			]
		};
		render(ReviewReport, { review, pullRequest, onPost: async () => {} });

		await expect.element(page.getByText('Suggestions (2)')).toBeVisible();
		const first = page.getByTestId('review-comment').first();
		await expect.element(first).toHaveTextContent('src/app.ts');
		await expect.element(first).toHaveTextContent('lines 3–4');
		await expect.element(first).toHaveTextContent('- let limit = 10;');
		await expect.element(first).toHaveTextContent('+ const LIMIT = 10;');
		// A comment outside the pull request's changes is marked; it goes in the main comment.
		await expect.element(page.getByTestId('not-in-diff')).toHaveTextContent('Not in the diff');
	});

	it('shows the set, then each pull request with its own post button', async () => {
		const posts: (string | undefined)[] = [];
		const review: ReviewResult = {
			scores,
			summary: 'They fit together.',
			verdict: 'request_changes',
			postedUrl: null,
			pullRequests: [
				part(1, 'api', { comments: [comment] }),
				part(3, 'web', { postedUrl: 'https://github.com/acme/web/pull/3#review' })
			]
		};
		render(ReviewReport, {
			review,
			pullRequest,
			onPost: async (url?: string) => {
				posts.push(url);
			}
		});

		await expect
			.element(page.getByTestId('review-set'))
			.toHaveTextContent('2 pull requests reviewed together');
		await expect.element(page.getByText('They fit together.')).toBeVisible();
		const cards = page.getByTestId('review-pull-request');
		await expect.element(cards.nth(0)).toHaveTextContent('#1 api part');
		await expect.element(cards.nth(0)).toHaveTextContent('Suggestions (1)');
		// The posted one links to its review; the other can be posted on its own, or with all.
		await expect
			.element(cards.nth(1).getByRole('link', { name: 'View posted review' }))
			.toBeVisible();
		await cards.nth(0).getByRole('button', { name: 'Post to GitHub' }).click();
		await page.getByRole('button', { name: 'Post all' }).click();
		expect(posts).toEqual(['https://github.com/acme/api/pull/1', undefined]);
	});
});
