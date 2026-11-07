import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// Must match PATCHWORK_REPOS in playwright.config.ts.
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
	return dir;
}

test('runs a change in the browser through the server', async ({ page }) => {
	const name = `web-${Date.now()}`;
	createRepo(name);

	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'Local folder' }).click();
	const candidates = page.getByTestId('repository-candidates');
	await expect(candidates).toContainText(name);
	await candidates.getByRole('button', { name: `Add ${name}` }).click();
	await expect(page.getByTestId('repository').filter({ hasText: name })).toContainText(
		`acme/${name}`
	);
	await expect(candidates).not.toContainText(name);

	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.locator('label', { hasText: name }).getByRole('checkbox').check();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog from the browser');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Add a changelog from the browser'
	);
	const task = page.getByTestId('task');
	// Live updates arrive over server-sent events.
	await expect(task.getByTestId('task-log')).toContainText(
		'Working on: Add a changelog from the browser'
	);
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await task.getByRole('tab', { name: 'Changes' }).click();
	await expect(task.getByTestId('diff')).toContainText('CHANGELOG.md');

	// A reload rebuilds everything from the server.
	await page.reload();
	await expect(page.getByTestId('task')).toHaveAttribute('data-task-status', 'awaiting_review');
});

test('refuses folders outside the repository folder', async ({ page }) => {
	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'Local folder' }).click();
	await page.getByLabel('Folder path').fill('/tmp');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText(
		'The server can only use repositories inside its repository folder.'
	);
});

test('asks for the access token when the server requires one', async ({ page }) => {
	await page.goto('http://localhost:4175/repositories');
	await expect(page.getByText('This server is protected.', { exact: false })).toBeVisible();

	await page.getByLabel('Token').fill('wrong');
	await page.getByRole('button', { name: 'Connect' }).click();
	await expect(page.getByRole('alert')).toHaveText('That token was not accepted.');

	await page.getByLabel('Token').fill('e2e-token');
	await page.getByRole('button', { name: 'Connect' }).click();
	await expect(page.getByText('Add a repository')).toBeVisible();

	// The token is remembered on this device.
	await page.reload();
	await expect(page.getByText('Add a repository')).toBeVisible();
});

test('the static build without a server explains what is needed', async ({ page }) => {
	await page.goto('http://localhost:4174/repositories');
	await expect(page.getByText('Needs the desktop app or the server')).toBeVisible();
});

test('publishes a pull request from the browser', async ({ page, request }) => {
	const name = `pub-${Date.now()}`;
	const bare = path.resolve('.e2e/remotes', `${name}.git`);
	mkdirSync(bare, { recursive: true });
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
	const dir = createRepo(name);
	const remote = `https://github.com/acme/${name}.git`;
	const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
	git('remote', 'set-url', 'origin', remote);
	git('config', `url.${bare}.insteadOf`, remote);
	git('config', 'user.email', 't@example.com');
	git('config', 'user.name', 'T');
	git('push', '-q', 'origin', 'main');

	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'Local folder' }).click();
	await page.getByRole('button', { name: `Add ${name}` }).click();
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.locator('label', { hasText: name }).getByRole('checkbox').check();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog via the web');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await task.getByRole('button', { name: 'Open pull request' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
	await expect(task).toHaveAttribute('data-task-status', 'published');
	await expect(task.getByRole('link', { name: 'Pull request #1' })).toBeVisible();

	const pulls = await (
		await request.get(`http://127.0.0.1:4011/repos/acme/${name}/pulls`, {
			headers: { authorization: 'Bearer x' }
		})
	).json();
	expect(pulls[0]).toMatchObject({ title: 'Add a changelog via the web', base: { ref: 'main' } });
	expect(git('ls-remote', '--heads', 'origin')).toContain(pulls[0].head.ref);
});

test('filters repositories by search in the Agent', async ({ page }) => {
	const stamp = Date.now();
	const names = [`alpha-${stamp}`, `beta-${stamp}`];
	for (const name of names) createRepo(name);

	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'Local folder' }).click();
	for (const name of names) {
		await page.getByRole('button', { name: `Add ${name}` }).click();
		await expect(page.getByTestId('repository').filter({ hasText: name })).toBeVisible();
	}

	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('searchbox', { name: 'Search repositories' }).fill(`beta-${stamp}`);
	await expect(page.getByText(`beta-${stamp}`, { exact: true })).toBeVisible();
	await expect(page.getByText(`alpha-${stamp}`, { exact: true })).toBeHidden();
	await page.getByRole('button', { name: 'Select shown' }).click();
	await expect(page.getByTestId('selected-count')).toHaveText('1 selected');

	await page.getByRole('searchbox', { name: 'Search repositories' }).fill('no-such-repo');
	await expect(page.getByText('No repositories match.')).toBeVisible();
});

test('searches and filters runs', async ({ page }) => {
	const name = `hist-${Date.now()}`;
	createRepo(name);
	await page.goto('/repositories');
	await page.getByRole('tab', { name: 'Local folder' }).click();
	await page.getByRole('button', { name: `Add ${name}` }).click();
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.locator('label', { hasText: name }).getByRole('checkbox').check();
	await page.getByRole('textbox', { name: 'Message' }).fill(`Searchable change ${name}`);
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();
	await expect(page.getByTestId('task')).toHaveAttribute('data-task-status', 'awaiting_review');

	await page.getByRole('link', { name: 'Runs', exact: true }).click();
	await page.getByRole('searchbox', { name: 'Search runs' }).fill(name);
	await expect(page.getByTestId('run')).toHaveCount(1);
	await page.getByRole('button', { name: 'In review' }).click();
	await expect(page.getByTestId('run')).toHaveCount(1);
	await page.getByRole('button', { name: 'Published' }).click();
	await expect(page.getByText('No runs match.')).toBeVisible();
	await page.getByRole('button', { name: 'All', exact: true }).click();
	await page.getByRole('searchbox', { name: 'Search runs' }).fill('nothing-like-this');
	await expect(page.getByText('No runs match.')).toBeVisible();
});

test('picks a local repository with the folder browser', async ({ page }) => {
	const name = `browse-${Date.now()}`;
	mkdirSync(path.join(reposRoot, 'team'), { recursive: true });
	const dir = path.join(reposRoot, 'team', name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	execFileSync('git', ['remote', 'add', 'origin', `git@github.com:acme/${name}.git`], { cwd: dir });

	await page.goto('/repositories');
	// Local folders are allowed on this server, so they come first.
	await expect(page.getByRole('tab', { name: 'Local folder' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await page.getByRole('button', { name: 'Browse…' }).click();

	const dialog = page.getByRole('dialog');
	await expect(dialog.getByTestId('folder-path')).toHaveText(reposRoot);
	await dialog
		.getByTestId('folder-list')
		.getByRole('button', { name: 'team', exact: true })
		.click();
	await expect(dialog.getByTestId('folder-path')).toHaveText(path.join(reposRoot, 'team'));
	await dialog.getByRole('button', { name: `Add ${name}` }).click();

	await expect(dialog).toBeHidden();
	await expect(page.getByTestId('repository').filter({ hasText: name })).toContainText(
		`acme/${name}`
	);
});
