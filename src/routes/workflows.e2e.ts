import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The fake GitHub and the gh-review fixture come from dev/e2e-github.ts. Serial: the Settings
// test changes the review defaults the other tests use.
test.describe.configure({ mode: 'serial' });
const FAKE_GITHUB = 'http://127.0.0.1:4011';

/** Push a branch (`feature` adding feature.txt) to acme/gh-review and open a pull request for it. */
async function openPullRequest(
	request: import('@playwright/test').APIRequestContext,
	branch = 'feature',
	title = 'Add a feature'
) {
	const bare = path.resolve('.e2e/gh-review.git');
	const work = mkdtempSync(path.join(tmpdir(), 'e2e-feature-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: work });
	git('clone', '-q', bare, '.');
	git('switch', '-q', '-c', branch);
	writeFileSync(path.join(work, `${branch}.txt`), `A new ${branch}\n`);
	git('add', '.');
	git('-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-q', '-m', 'Feature');
	git('push', '-q', 'origin', branch);
	rmSync(work, { recursive: true, force: true });
	const res = await request.post(`${FAKE_GITHUB}/repos/acme/gh-review/pulls`, {
		headers: { authorization: 'Bearer e2e-token' },
		data: { title, head: branch, base: 'main' }
	});
	expect(res.status()).toBe(201);
	return ((await res.json()) as { html_url: string; number: number }).number;
}

test('workflows start from the Agent; old links open it in the right mode', async ({ page }) => {
	await page.goto('/');
	const sidebar = page.locator('[data-sidebar="sidebar"]');
	await expect(sidebar.getByText('Workflows')).toBeVisible();
	await expect(sidebar.getByRole('link', { name: 'Review PR' })).toHaveCount(0);

	await page.goto('/review');
	await expect(page).toHaveURL(/\/agent\?mode=review$/);
	const mode = page.getByTestId('agent-mode');
	await expect(mode.getByText('Review')).toHaveAttribute('data-state', 'on');
	await page.goto('/explore');
	await expect(mode.getByText('Explore')).toHaveAttribute('data-state', 'on');
	await page.goto('/changes/new');
	await expect(mode.getByText('Change')).toHaveAttribute('data-state', 'on');
});

test('reviews a pull request in the Agent, posts it and answers a question', async ({
	page,
	request
}) => {
	const number = await openPullRequest(request);

	await page.goto('/agent');
	const box = page.getByRole('textbox', { name: 'Message' });
	// Auto mode reads the message: "review <link>" is a review.
	const mode = page.getByTestId('agent-mode');
	await box.fill('How should we add caching?');
	await expect(mode).toHaveAttribute('data-mode', 'explore');
	await expect(mode).toContainText('Auto: Explore');
	await box.fill(`review https://github.com/acme/gh-review/pull/${number} focus on naming`);
	await expect(mode).toHaveAttribute('data-mode', 'review');
	await expect(mode).toContainText('Auto: Review');
	// Picking a mode yourself sticks until you pick Auto again.
	await mode.getByText('Change', { exact: true }).click();
	await box.fill(`review https://github.com/acme/gh-review/pull/${number} focus on naming!`);
	await expect(mode).toHaveAttribute('data-mode', 'change');
	await mode.getByText('Auto').click();
	await expect(mode).toHaveAttribute('data-mode', 'review');
	const panel = page.getByTestId('agent-review-panel');
	await expect(panel).toContainText(`Reviewing https://github.com/acme/gh-review/pull/${number}`);
	await panel.getByLabel('Performance').uncheck();
	await panel.getByPlaceholder('Name, e.g. Accessibility').fill('Accessibility');
	await panel.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('button', { name: 'Send' }).click();

	await expect(page).toHaveURL(/\/agent\/[0-9a-f-]+$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review: Add a feature');
	await expect(page.getByTestId('agent-task')).toHaveAttribute('data-task-status', 'completed');
	const thread = page.getByTestId('agent-thread');
	await expect(thread.locator('[data-kind="user"]').first()).toContainText('focus on naming');
	const report = thread.getByTestId('review-report');
	await expect(report.getByTestId('review-score')).toHaveCount(6);
	await expect(report).toContainText('Accessibility');
	await expect(report).not.toContainText('Performance');
	// The JSON the agent ends with is shown as the card, not as text.
	await expect(thread.locator('[data-kind="assistant"]').last()).toBeVisible();
	await expect(thread).not.toContainText('"verdict": "comment"');

	await report.getByRole('button', { name: 'Post to GitHub' }).click();
	await expect(report.getByRole('link', { name: 'View posted review' })).toHaveAttribute(
		'href',
		new RegExp(`/acme/gh-review/pull/${number}#pullrequestreview-\\d+$`)
	);

	// Ask a follow-up question: the agent looks again, read-only.
	const reply = page.getByRole('textbox', { name: 'Ask a question about this…' });
	await reply.fill('Why that security score?');
	await reply.press('Enter');
	await expect(thread.locator('[data-kind="user"]').last()).toContainText(
		'Why that security score?'
	);
	await expect(page.getByTestId('agent-task')).toHaveAttribute('data-task-status', 'completed');
	await expect(thread.getByTestId('review-report')).toHaveCount(1);

	// The run list labels it as a review.
	await page.goto('/runs');
	await expect(
		page.getByTestId('run').filter({ hasText: 'focus on naming' }).first()
	).toContainText('Review');
});

test('reviews the parts of a split change together, with suggestions, and posts each', async ({
	page,
	request
}) => {
	const first = await openPullRequest(request, 'split-models', 'Split: models');
	const second = await openPullRequest(request, 'split-views', 'Split: views');
	const link = (n: number) => `https://github.com/acme/gh-review/pull/${n}`;

	await page.goto('/agent');
	await page
		.getByRole('textbox', { name: 'Message' })
		.fill(`review ${link(first)} and ${link(second)} together`);
	const panel = page.getByTestId('agent-review-panel');
	await expect(panel).toContainText(`Reviewing ${link(first)}`);
	await expect(panel).toContainText(`Reviewing ${link(second)}`);
	await page.getByRole('button', { name: 'Send' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review: 2 pull requests');
	await expect(page.getByTestId('agent-task')).toHaveAttribute('data-task-status', 'completed');
	const report = page.getByTestId('agent-thread').getByTestId('review-report');
	await expect(report.getByTestId('review-set')).toHaveText('2 pull requests reviewed together');
	const cards = report.getByTestId('review-pull-request');
	await expect(cards).toHaveCount(2);
	// Each part has its own suggestion: its new file's first line, in capitals.
	await expect(cards.nth(0)).toContainText('Split: models');
	await expect(cards.nth(0).getByTestId('review-comment')).toContainText('split-models.txt');
	await expect(cards.nth(0).getByTestId('review-comment')).toContainText('+ A NEW SPLIT-MODELS');
	await expect(cards.nth(1).getByTestId('review-comment')).toContainText('split-views.txt');

	await report.getByRole('button', { name: 'Post all' }).click();
	for (const i of [0, 1]) {
		await expect(cards.nth(i).getByRole('link', { name: 'View posted review' })).toBeVisible();
	}
	await expect(report.getByRole('button', { name: 'Post all' })).toHaveCount(0);
});

test('explores in the Agent and builds an approach', async ({ page }) => {
	await page.goto('/agent?mode=explore');
	await page.locator('label', { hasText: 'gh-review' }).getByRole('checkbox').check();
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Add a cache');
	await box.press('Enter');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add a cache');
	await expect(page.getByTestId('agent-task')).toHaveAttribute('data-task-status', 'completed');
	const thread = page.getByTestId('agent-thread');
	await expect(thread.getByTestId('approach')).toHaveCount(2);
	await expect(thread).toContainText('Recommendation');

	await thread
		.getByTestId('approach')
		.first()
		.getByRole('button', { name: 'Build this approach' })
		.click();
	// A new conversation for the change.
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Use this approach');
	await expect(page.getByTestId('agent-task')).toHaveAttribute(
		'data-task-status',
		'awaiting_review'
	);
});

test('review attributes can be changed in Settings', async ({ page }) => {
	await page.goto('/settings');
	const list = page.getByTestId('review-attribute-settings');
	await expect(list.getByRole('textbox', { name: 'Name' })).toHaveCount(6);
	await page.getByRole('button', { name: 'Add attribute' }).click();
	await list.getByRole('textbox', { name: 'Name' }).last().fill('Docs');
	await list
		.getByRole('textbox', { name: 'What a good score means' })
		.last()
		.fill('Public APIs are documented.');
	await page.getByRole('button', { name: 'Save attributes' }).click();
	await expect(page.getByText('Saved', { exact: true }).last()).toBeVisible();

	await page.goto('/agent?mode=review');
	await expect(page.getByTestId('review-attributes')).toContainText('Docs');

	// Put the defaults back for other tests.
	await page.goto('/settings');
	await list.getByRole('button', { name: 'Remove Docs' }).click();
	await page.getByRole('button', { name: 'Save attributes' }).click();
	await expect(page.getByText('Saved', { exact: true }).last()).toBeVisible();
});

test('a question gets a read-only answer, not a branch', async ({ page }) => {
	await page.goto('/agent');
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('can you explain what gh-review is');
	const mode = page.getByTestId('agent-mode');
	await expect(mode).toHaveAttribute('data-mode', 'ask');
	await expect(mode).toContainText('Auto: Ask');
	await page.locator('label', { hasText: 'gh-review' }).getByRole('checkbox').check();
	await box.press('Enter');

	await expect(page).toHaveURL(/\/agent\/[0-9a-f-]+$/);
	await expect(page.getByTestId('agent-task')).toHaveAttribute('data-task-status', 'completed');
	const thread = page.getByTestId('agent-thread');
	await expect(thread.locator('[data-kind="assistant"]').last()).toContainText(
		'Here is what I found about: can you explain what gh-review is'
	);
	await expect(thread).not.toContainText('Created branch');
	// The answer is Markdown: a heading and a table, not ## and pipes.
	const answer = thread.locator('[data-kind="assistant"]').last();
	await expect(answer.getByRole('heading', { name: 'Components' })).toBeVisible();
	await expect(answer.getByRole('table')).toBeVisible();
	await expect(answer).not.toContainText('|---|');

	// Ask again in the same conversation.
	const reply = page.getByRole('textbox', { name: 'Ask a question about this…' });
	const replyMode = page.getByTestId('agent-reply-mode');
	await reply.fill('Where are the tests?');
	await expect(replyMode).toContainText('Auto: Ask');
	await reply.press('Enter');
	await expect(thread.locator('[data-kind="user"]').last()).toContainText('Where are the tests?');
	await expect(page.getByTestId('agent-task')).toHaveAttribute('data-task-status', 'completed');

	// Picking Ask yourself keeps a reply read-only, whatever it says.
	await replyMode.getByText('Ask', { exact: true }).click();
	await reply.fill('Add a test for it');
	await expect(replyMode).toHaveAttribute('data-mode', 'reply');
	await expect(page.getByText('Sending turns this conversation into a change')).toHaveCount(0);

	// Auto sees a change request and switches in the same conversation: a branch, edits, review.
	await replyMode.getByText('Auto').click();
	await reply.fill('Add a page about the tests');
	await expect(replyMode).toContainText('Auto: Change');
	await expect(page.getByText('Sending turns this conversation into a change')).toBeVisible();
	await reply.press('Enter');
	await expect(page.getByTestId('agent-task')).toHaveAttribute(
		'data-task-status',
		'awaiting_review'
	);
	await expect(thread).toContainText('Switching to a change on the branch ai/add-a-page-about');
	await expect(thread.locator('[data-kind="user"]')).toHaveCount(3);
	await expect(replyMode).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Reply to the agent…' })).toBeVisible();
});
