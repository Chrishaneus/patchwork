import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// Must match PATCHWORK_REPOS in playwright.config.ts; the server uses a scripted agent.
const reposRoot = path.resolve('.e2e/repos');

function createRepo(name: string) {
	const dir = path.join(reposRoot, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
	git('init', '-q', '-b', 'main');
	git(
		'-c',
		'user.email=t@example.com',
		'-c',
		'user.name=T',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'init'
	);
	git('remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
}

async function addRepos(page: Page, names: string[]) {
	for (const name of names) createRepo(name);
	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'Local folder' }).click();
	for (const name of names) {
		await page.getByRole('button', { name: `Add ${name}` }).click();
		await expect(page.getByTestId('repository').filter({ hasText: name })).toBeVisible();
	}
}

const pick = (page: Page, name: string) =>
	page.locator('label', { hasText: name }).getByRole('checkbox').check();

test('talks to the agent about a change in one repository', async ({ page }) => {
	const name = `chat-${Date.now()}`;
	await addRepos(page, [name]);

	await page.getByRole('link', { name: 'Agent' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent');
	await pick(page, name);
	const start = page.getByRole('textbox', { name: 'Message' });
	await start.fill('Add a changelog');
	await start.press('Enter');

	await expect(page).toHaveURL(/\/agent\/[0-9a-f-]+$/);
	const thread = page.getByTestId('agent-thread');
	await expect(thread.locator('[data-kind="user"]').first()).toContainText('Add a changelog');
	// The scripted agent notes what it's doing, then replies once the change is ready for review.
	await expect(thread.locator('[data-kind="note"]').first()).toContainText(
		'Working on: Add a changelog'
	);
	await expect(page.getByTestId('agent-task')).toHaveAttribute(
		'data-task-status',
		'awaiting_review'
	);
	await expect(thread.locator('[data-kind="assistant"]')).toHaveCount(1);
	await expect(thread.locator('[data-kind="assistant"]')).toContainText('Added a changelog entry');
	await expect(thread).toContainText('Write CHANGELOG.md');

	const reply = page.getByRole('textbox', { name: 'Reply to the agent…' });
	await reply.fill('Also mention the release date');
	await reply.press('Enter');
	await expect(thread.locator('[data-kind="user"]').last()).toContainText(
		'Also mention the release date'
	);
	await expect(page.getByTestId('agent-task')).toHaveAttribute(
		'data-task-status',
		'awaiting_review'
	);
	await expect(thread.locator('[data-kind="assistant"]').last()).toContainText(
		'Added a changelog entry'
	);
	await expect(reply).toHaveValue('');

	// The conversation is listed, and the run page has the review and publish tools.
	await expect(page.getByRole('navigation', { name: 'Recent' })).toContainText('Add a changelog');
	await page.getByRole('link', { name: 'Review & publish' }).click();
	await expect(page.getByTestId('task')).toContainText('Ready for review');
});

test('sends a reply to all repositories, and shows each one on its own', async ({ page }) => {
	const stamp = Date.now();
	const names = [`left-${stamp}`, `right-${stamp}`];
	await addRepos(page, names);

	await page.goto('/agent');
	for (const name of names) await pick(page, name);
	const start = page.getByRole('textbox', { name: 'Message' });
	await start.fill('Add a changelog everywhere');
	await start.press('Enter');

	const tasks = page.getByTestId('agent-task');
	await expect(tasks).toHaveCount(2);
	for (const name of names) {
		await expect(tasks.filter({ hasText: name })).toHaveAttribute(
			'data-task-status',
			'awaiting_review'
		);
	}

	const reply = page.getByRole('textbox', { name: 'Reply to the agent…' });
	await reply.fill('Keep it short');
	await reply.press('Enter');
	const thread = page.getByTestId('agent-thread');
	// One message, sent to both repositories.
	const sent = thread.locator('[data-kind="user"]', { hasText: 'Keep it short' });
	await expect(sent).toHaveCount(1);
	for (const name of names) await expect(sent).toContainText(name);
	for (const name of names) {
		await expect(tasks.filter({ hasText: name })).toHaveAttribute(
			'data-task-status',
			'awaiting_review'
		);
	}

	await page.getByRole('tab', { name: names[1] }).click();
	await expect(thread).toContainText('Keep it short');
	await expect(thread.locator('[data-kind="note"]').first()).toContainText('Working on');
});

test('long URLs, paths and names never make the page scroll sideways', async ({ page }) => {
	const name = `a-repository-with-an-unusually-long-name-${Date.now()}`;
	await addRepos(page, [name]);
	await page.goto('/agent');
	await pick(page, name);
	const start = page.getByRole('textbox', { name: 'Message' });
	await start.fill(
		'Update https://github.com/acme/some-very-long-repository-name/blob/main/docs/configuration/advanced-settings.md and src/components/really/deeply/nested/folder/structure/ComponentWithAVeryLongName.svelte'
	);
	await start.press('Enter');
	await expect(page.getByTestId('agent-task')).toHaveAttribute(
		'data-task-status',
		'awaiting_review'
	);

	const fits = () =>
		page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		);
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 800 });
		await expect.poll(fits).toBe(true);
	}
	await page.getByRole('link', { name: 'Review & publish' }).click();
	await expect(page.getByTestId('task')).toBeVisible();
	await expect.poll(fits).toBe(true);
});

test('on a phone, the repository panel collapses to one line', async ({ page }) => {
	const stamp = Date.now();
	const names = [`phone-a-${stamp}`, `phone-b-${stamp}`];
	await addRepos(page, names);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/agent');

	const toggle = page.getByTestId('agent-repositories-toggle');
	await expect(toggle).toContainText('0 selected');
	// Collapsed: the list is hidden until you open it.
	await expect(page.locator('label', { hasText: names[0] })).toBeHidden();
	await toggle.click();
	for (const name of names) await pick(page, name);
	await expect(toggle).toContainText('2 selected');

	const start = page.getByRole('textbox', { name: 'Message' });
	await start.fill('Add a changelog');
	await start.press('Enter');
	const summary = page.getByTestId('agent-conversation-repos-toggle');
	await expect(summary).toContainText('All repositories (2)');
	await expect(page.getByTestId('agent-task').first()).toBeHidden();
	await expect(summary).not.toContainText('working');

	// Open it to talk to one repository.
	await summary.click();
	await page.getByRole('tab', { name: names[1] }).click();
	await expect(summary).toContainText(names[1]);
});

test('lists recent conversations when the Agent is opened directly', async ({ page }) => {
	const name = `recent-${Date.now()}`;
	await addRepos(page, [name]);
	await page.goto('/agent');
	await pick(page, name);
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill(`Recent ${name}`);
	await box.press('Enter');
	await expect(page).toHaveURL(/\/agent\/[0-9a-f-]+$/);
	await page.goto('/agent');
	await expect(page.getByRole('navigation', { name: 'Recent' })).toContainText(`Recent ${name}`);
});
