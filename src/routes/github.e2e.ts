import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The fake GitHub and fixtures come from dev/e2e-github.ts (see playwright.config.ts).
const FAKE_GITHUB = 'http://127.0.0.1:4011';

/** A bare repository with one commit, cloneable by file:// URL. */
function bareRepo(name: string) {
	const bare = path.resolve('.e2e/remotes', `${name}.git`);
	rmSync(bare, { recursive: true, force: true });
	mkdirSync(bare, { recursive: true });
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
	const seed = mkdtempSync(path.join(tmpdir(), 'e2e-seed-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: seed });
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
	git('push', '-q', bare, 'main');
	rmSync(seed, { recursive: true, force: true });
	return bare;
}

test('signs in with GitHub and clones a repository from the list', async ({ page, request }) => {
	await page.goto('/settings');
	const card = page.getByTestId('github-signin');
	await expect(card.getByTestId('github-client-id')).toHaveText('Iv23liE2eClient');
	await card.getByRole('button', { name: 'Sign in with GitHub' }).click();

	const code = (await card.getByTestId('github-user-code').textContent())!.trim();
	expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	await expect(card.getByRole('link', { name: 'Open GitHub' })).toHaveAttribute(
		'href',
		`${FAKE_GITHUB}/login/device`
	);
	// Approve on (fake) GitHub, as the user would in the browser.
	await request.post(`${FAKE_GITHUB}/login/device`, {
		form: { user_code: code, decision: 'approve' }
	});
	await expect(card.getByTestId('github-account')).toHaveText('Signed in as e2e-user');

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByRole('tab', { name: 'From a URL' }).click();
	const list = page.getByTestId('github-repositories');
	await expect(list).toContainText('acme/gh-demo');
	await list.getByRole('button', { name: 'Add acme/gh-demo' }).click();
	const repo = page.getByTestId('repository').filter({ hasText: 'acme/gh-demo' });
	await expect(repo).toContainText('App copy');
	await expect(repo).toContainText('GitHub');
	// Added, not cloned yet; added repositories leave the list.
	await expect(repo.getByTestId('clone-status')).toHaveAttribute('data-clone-status', 'pending');
	await expect(list).not.toContainText('acme/gh-demo');
	await repo.getByRole('button', { name: 'Clone now' }).click();
	await expect(repo.getByTestId('clone-status')).toHaveCount(0);
	await expect(repo).toContainText('On main');

	// Or pick a GitHub repository right in the Agent: it's cloned when the run starts.
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.locator('label', { hasText: 'gh-second' }).getByRole('checkbox').check();
	// gh-demo may be preselected when it's the only repository added so far.
	await page.locator('label', { hasText: 'gh-demo' }).getByRole('checkbox').setChecked(false);
	await expect(page.getByText('acme/gh-second · From your GitHub', { exact: false })).toBeVisible();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog to gh-second');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();
	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await expect(task.getByTestId('task-log')).toContainText(
		'Cloning https://github.com/acme/gh-second.git'
	);

	await page.getByRole('link', { name: 'Settings' }).click();
	await card.getByRole('button', { name: 'Sign out' }).click();
	await expect(card.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});

test('adds a repository by URL and deletes the app copy on remove', async ({ page }) => {
	const name = `url-${Date.now()}`;
	const bare = bareRepo(name);

	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'From a URL' }).click();
	await page.getByLabel('Repository URL').fill(`file://${bare}`);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const repo = page.getByTestId('repository').filter({ hasText: name });
	await expect(repo).toContainText('App copy');
	await expect(repo).toContainText('Not cloned yet');
	const clonePath = (await repo.locator('[data-slot="card-description"]').textContent())!.trim();
	expect(clonePath).toContain('/clones/');
	expect(existsSync(clonePath)).toBe(false);

	await repo.getByRole('button', { name: 'Clone now' }).click();
	await expect(repo).toContainText('On main');
	expect(existsSync(clonePath)).toBe(true);

	await repo.getByRole('button', { name: 'Remove' }).click();
	await expect(page.getByRole('alertdialog')).toContainText('deletes its own copy');
	await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
	await expect(repo).toHaveCount(0);
	expect(existsSync(clonePath)).toBe(false);
});

test('a server without mounted folders only adds repositories by URL', async ({ page }) => {
	await page.goto('http://localhost:4176/repositories');
	await expect(page.getByRole('tab', { name: 'From a URL' })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Local folder' })).toHaveCount(0);

	await page.getByLabel('Repository URL').fill(`file://${bareRepo(`blocked-${Date.now()}`)}`);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText(
		'Enter an https://, ssh:// or git@host:owner/name URL.'
	);
});
