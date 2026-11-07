import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeGitHub } from '../dev/fake-github';

const appDir = path.join(import.meta.dirname, '..');
const temp: string[] = [];
const makeTemp = (prefix: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	temp.push(dir);
	return dir;
};

function createRepo(remote: string) {
	const dir = makeTemp('patchwork-repo-');
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
	git('remote', 'add', 'origin', remote);
	writeFileSync(path.join(dir, 'notes.txt'), 'uncommitted');
	return dir;
}

async function launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
	// Tools like VS Code's extension host set ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATCHWORK_DATA_DIR: makeTemp('patchwork-data-'),
		// Keep the app window off the desktop while tests run.
		PATCHWORK_HIDE_WINDOW: '1',
		...extraEnv
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return electron.launch({ args: [appDir], env: env as Record<string, string> });
}

test.afterAll(() => {
	for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

test('loads the build, exposes the bridge and supports locale routes', async () => {
	const app = await launch();
	const page = await app.firstWindow();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
	expect(await page.evaluate(() => window.electron?.platform)).toBe(process.platform);

	// Deep link to a client-side route must fall back to index.html.
	await page.goto('app://bundle/es');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Panel');
	expect(await page.evaluate(() => document.documentElement.lang)).toBe('es');

	await app.close();
});

test('adds, re-checks and removes repositories through the engine', async () => {
	const app = await launch();
	const page = await app.firstWindow();
	const repoDir = createRepo('git@github.com:acme/widgets.git');
	const plainDir = makeTemp('patchwork-plain-');

	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page.getByText('No repositories yet.', { exact: false })).toBeVisible();

	const pathInput = page.getByLabel('Folder path');
	await pathInput.fill(plainDir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText("That folder isn't inside a git repository.");

	await pathInput.fill(repoDir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const card = page.getByTestId('repository');
	await expect(card).toContainText('widgets');
	await expect(card).toContainText('acme/widgets');
	await expect(card).toContainText('1 uncommitted change');
	await expect(pathInput).toHaveValue('');

	await pathInput.fill(repoDir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText('That repository is already added.');

	rmSync(path.join(repoDir, 'notes.txt'));
	await card.getByRole('button', { name: 'Re-check' }).click();
	await expect(card).toContainText('No uncommitted changes');

	// The dashboard counter reflects the saved repository.
	await page.getByRole('link', { name: 'Dashboard' }).click();
	await expect(page.getByText('Saved repositories').locator('..')).toContainText('1');

	await page.getByRole('link', { name: 'Repositories' }).click();
	await card.getByRole('button', { name: 'Remove' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
	await expect(card).toHaveCount(0);

	await app.close();
});

test('runs a change: live log, diff, summary and discard', async () => {
	const app = await launch({ PATCHWORK_TEST_AGENT: 'edit' });
	const page = await app.firstWindow();
	const repoDir = createRepo('git@github.com:acme/widgets.git');

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repoDir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByTestId('repository')).toBeVisible();

	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	// The only repository is preselected, and can still be unticked (it isn't re-selected).
	await expect(page.getByRole('checkbox')).toBeChecked();
	await page.getByRole('checkbox').uncheck();
	await page.waitForTimeout(300);
	await expect(page.getByRole('checkbox')).not.toBeChecked();
	await page.getByRole('checkbox').check();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add a changelog');
	const task = page.getByTestId('task');
	await expect(task.getByTestId('task-log')).toContainText('Working on: Add a changelog');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await expect(task.getByTestId('task-log')).toContainText('Write CHANGELOG.md');
	await expect(task).toContainText('1 file · +3 −0');
	await expect(task).toContainText('$0.012');

	await task.getByRole('tab', { name: 'Changes' }).click();
	await expect(task.getByTestId('diff')).toContainText('CHANGELOG.md');
	await expect(task.getByTestId('diff')).toContainText('+- Add a changelog');
	await task.getByRole('tab', { name: 'Summary' }).click();
	await expect(task).toContainText('Added a changelog entry');

	// The runs list and dashboard show the run.
	await page.getByRole('link', { name: 'Runs', exact: true }).click();
	await expect(page.getByTestId('run')).toContainText('Ready for review');

	await page.getByTestId('run').click();
	await task.getByRole('button', { name: 'Discard' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
	await expect(task).toHaveAttribute('data-task-status', 'discarded');
	expect(
		execFileSync('git', ['branch', '--list', 'ai/*'], { cwd: repoDir, encoding: 'utf8' })
	).toBe('');

	await app.close();
});

test('cancels a running change', async () => {
	const app = await launch({ PATCHWORK_TEST_AGENT: 'hang' });
	const page = await app.firstWindow();
	const repoDir = createRepo('git@github.com:acme/widgets.git');

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repoDir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('Never finishes');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'running');
	await page.getByRole('link', { name: 'Dashboard' }).click();
	await expect(page.getByText('Active runs').locator('..')).toContainText('1');
	await page.goBack();

	await task.getByRole('button', { name: 'Cancel' }).click();
	await expect(task).toHaveAttribute('data-task-status', 'cancelled');
	await expect(task.getByTestId('task-log')).toContainText('Cancelled.');

	await app.close();
});

test('saves settings without showing the API key again', async () => {
	const app = await launch();
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Settings' }).click();
	await expect(page.getByTestId('model-name')).toHaveText('Claude Opus 5.5');

	// Pick a model from the nested menu: provider, then model.
	await page.locator('#model').click();
	await page.getByRole('menuitem', { name: 'Anthropic' }).click();
	await page.getByRole('menuitem', { name: /Claude Sonnet 5\.5/ }).click();
	await expect(page.getByTestId('model-name')).toHaveText('Claude Sonnet 5.5');
	await page.getByLabel('Time limit (minutes)').fill('15');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Saved');

	await page.reload();
	await expect(page.getByLabel('Time limit (minutes)')).toHaveValue('15');
	await expect(page.getByTestId('model-name')).toHaveText('Claude Sonnet 5.5');

	// Or type any other model ID.
	await page.locator('#model').click();
	await page.getByRole('menuitem', { name: 'Custom model ID…' }).click();
	await page.getByLabel('Model ID').fill('claude-experimental-x');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.reload();
	await expect(page.getByTestId('model-name')).toHaveText('Custom model');
	await expect(page.getByLabel('Model ID')).toHaveValue('claude-experimental-x');

	// Whether the agent's commands are sandboxed depends on the machine; it's said either way.
	await expect(page.getByTestId('sandbox-status')).toContainText('sandbox');

	await page.getByLabel('API key').fill('sk-ant-test-123');
	await page.getByRole('button', { name: 'Save key' }).click();
	await expect(page.getByTestId('key-status')).toHaveText('A key is saved.');
	await expect(page.getByLabel('API key')).toHaveValue('');
	await page.getByRole('button', { name: 'Remove saved key' }).click();
	await expect(page.getByTestId('key-status')).not.toHaveText('A key is saved.');

	await app.close();
});

/** A repo whose GitHub-looking remote is rewritten to a local bare repository. */
function createGitHubLikeRepo(slug: string) {
	const bare = makeTemp('patchwork-remote-');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
	const remote = `https://github.com/${slug}.git`;
	const dir = createRepo(remote);
	const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
	git('config', 'user.email', 't@example.com');
	git('config', 'user.name', 'T');
	git('config', `url.${bare}.insteadOf`, remote);
	git('push', '-q', 'origin', 'main');
	return { dir, bare };
}

test('publishes a reviewed change as a pull request', async () => {
	const repo = createGitHubLikeRepo('acme/widgets');
	const gh = await startFakeGitHub({ repos: { 'acme/widgets': repo.bare } });
	const app = await launch({
		PATCHWORK_TEST_AGENT: 'edit',
		PATCHWORK_GITHUB_API_URL: gh.url,
		GITHUB_TOKEN: 'e2e-token'
	});
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repo.dir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await task.getByRole('button', { name: 'Open pull request' }).click();

	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('Title')).toHaveValue('Add a changelog');
	await expect(dialog.getByLabel('Description')).toHaveValue(/Added a changelog entry/);
	await dialog.getByLabel('Title').fill('Add a changelog entry');
	await dialog.getByRole('button', { name: 'Publish' }).click();

	await expect(task).toHaveAttribute('data-task-status', 'published');
	await expect(task.getByRole('link', { name: 'Pull request #1' })).toHaveAttribute(
		'href',
		`${gh.url}/acme/widgets/pull/1`
	);
	expect(gh.pulls[0]).toMatchObject({ title: 'Add a changelog entry', base: 'main' });
	const branch = gh.pulls[0].head;
	expect(
		execFileSync('git', ['log', '-1', '--format=%s', branch], {
			cwd: repo.bare,
			encoding: 'utf8'
		}).trim()
	).toBe('Add a changelog entry');

	// The diff stays available after the worktree is cleaned up.
	await task.getByRole('tab', { name: 'Changes' }).click();
	await expect(task.getByTestId('diff')).toContainText('CHANGELOG.md');

	await page.getByRole('link', { name: 'Dashboard' }).click();
	await expect(page.getByText('Open pull requests').locator('..')).toContainText('1');

	await app.close();
	await gh.close();
});

test('stops before touching git when no GitHub token is set', async () => {
	const repo = createGitHubLikeRepo('acme/widgets');
	// No token anywhere: publishing must stop before touching git.
	const app = await launch({ PATCHWORK_TEST_AGENT: 'edit', GITHUB_TOKEN: '', GH_TOKEN: '' });
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repo.dir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await task.getByRole('button', { name: 'Open pull request' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
	await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
		'Add a GitHub token in Settings to open pull requests.'
	);
	expect(
		execFileSync('git', ['branch', '--list'], { cwd: repo.bare, encoding: 'utf8' })
	).not.toContain('ai/');

	await app.close();
});

test('runs checks per repository and publishes the changes that passed', async () => {
	const good = createGitHubLikeRepo('acme/good');
	const bad = createGitHubLikeRepo('acme/bad');
	const gh = await startFakeGitHub();
	const app = await launch({
		PATCHWORK_TEST_AGENT: 'edit',
		PATCHWORK_GITHUB_API_URL: gh.url,
		GITHUB_TOKEN: 'e2e-token'
	});
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Repositories' }).click();
	for (const dir of [good.dir, bad.dir]) {
		await page.getByLabel('Folder path').fill(dir);
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByLabel('Folder path')).toHaveValue('');
	}
	const card = (name: string) => page.getByTestId('repository').filter({ hasText: `acme/${name}` });
	// The scripted agent writes CHANGELOG.md, so this check passes; the other always fails.
	for (const [name, command] of [
		['good', 'test -f CHANGELOG.md && echo changelog present'],
		['bad', 'echo "lint: 2 problems" && exit 1']
	]) {
		await card(name).getByRole('button', { name: 'Edit checks' }).click();
		await card(name).getByLabel('Check command').fill(command);
		await card(name).getByRole('button', { name: 'Save' }).click();
		await expect(card(name).getByTestId('check-command')).toHaveText(command);
	}

	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('button', { name: 'Select shown' }).click();
	await expect(page.getByTestId('selected-count')).toHaveText('2 selected');
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	// Match the repository name exactly: other text on a card (e.g. a random temp folder) could contain it.
	const task = (name: string) =>
		page.getByTestId('task').filter({ has: page.getByText(name, { exact: true }) });
	await expect(task('good')).toHaveAttribute('data-task-status', 'awaiting_review');
	await expect(task('bad')).toHaveAttribute('data-task-status', 'awaiting_review');
	await expect(task('good')).toContainText('Checks passed');
	await expect(task('bad')).toContainText('Checks failed');
	await task('bad').getByRole('tab', { name: 'Checks' }).click();
	await expect(task('bad').getByTestId('checks-output')).toContainText('lint: 2 problems');

	await page.getByRole('button', { name: 'Publish all ready' }).click();
	const dialog = page.getByRole('dialog');
	const row = (name: string) =>
		dialog.getByTestId('bulk-publish-tasks').locator('li').filter({ hasText: name });
	await expect(row('good').getByRole('checkbox')).toBeChecked();
	await expect(row('bad').getByRole('checkbox')).not.toBeChecked();
	await dialog.getByRole('button', { name: 'Publish 1 change' }).click();
	await expect(row('good')).toContainText('Published');
	await dialog.getByRole('button', { name: 'Done' }).click();

	await expect(task('good')).toHaveAttribute('data-task-status', 'published');
	await expect(task('bad')).toHaveAttribute('data-task-status', 'awaiting_review');
	expect(gh.pulls.map((p) => p.repo)).toEqual(['acme/good']);

	// Fix the failing check and run it again.
	await page.getByRole('link', { name: 'Repositories' }).click();
	await card('bad').getByRole('button', { name: 'Edit checks' }).click();
	await card('bad').getByLabel('Check command').fill('echo ok');
	await card('bad').getByRole('button', { name: 'Save' }).click();
	await page.goBack();
	await task('bad').getByRole('tab', { name: 'Checks' }).click();
	await task('bad').getByRole('button', { name: 'Run checks again' }).click();
	await expect(task('bad')).toContainText('Checks passed');

	await app.close();
	await gh.close();
});

test('follow-ups continue a change, including fixing failing checks', async () => {
	const repo = createGitHubLikeRepo('acme/widgets');
	const app = await launch({ PATCHWORK_TEST_AGENT: 'edit' });
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repo.dir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const card = page.getByTestId('repository');
	await card.getByRole('button', { name: 'Edit checks' }).click();
	await card.getByLabel('Check command').fill('test -f NOTES.md');
	await card.getByRole('button', { name: 'Save' }).click();
	await expect(card.getByTestId('check-command')).toBeVisible();

	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();

	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await expect(task).toContainText('Checks failed');

	const followUp = task.getByTestId('follow-up');
	await followUp.getByLabel('Follow up').fill('Also describe the release');
	await followUp.getByRole('button', { name: 'Send to agent' }).click();
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await expect(task.getByTestId('task-log')).toContainText('Follow-up: Also describe the release');
	await expect(followUp).toContainText('↳ Also describe the release');
	await expect(task).toContainText('4 turns');

	// "Fix failing checks" sends a ready-made instruction; the agent gets the check output.
	await followUp.getByRole('button', { name: 'Fix failing checks' }).click();
	await expect(task.getByTestId('task-log')).toContainText('Follow-up: The repository');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');

	await app.close();
});

test('shows pull request status after it is merged', async () => {
	const repo = createGitHubLikeRepo('acme/widgets');
	const gh = await startFakeGitHub({ repos: { 'acme/widgets': repo.bare } });
	const app = await launch({
		PATCHWORK_TEST_AGENT: 'edit',
		PATCHWORK_GITHUB_API_URL: gh.url,
		GITHUB_TOKEN: 'e2e-token'
	});
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repo.dir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('Add a changelog');
	await page.getByRole('button', { name: 'Send' }).click();
	// The conversation opens; the run page has the diff and publishing.
	await page.getByRole('link', { name: 'Review & publish' }).click();
	const task = page.getByTestId('task');
	await expect(task).toHaveAttribute('data-task-status', 'awaiting_review');
	await task.getByRole('button', { name: 'Open pull request' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
	await expect(task.getByTestId('pull-request')).toHaveAttribute('data-pr-state', 'open');

	gh.setState('acme/widgets', 1, 'merged');
	await page.getByRole('link', { name: 'Runs', exact: true }).click();
	await page.getByRole('button', { name: 'Refresh PR status' }).click();
	await expect(page.getByTestId('run').locator('[data-pr-state]')).toHaveText('Merged');
	await page.getByTestId('run').click();
	await expect(task.getByTestId('pull-request')).toHaveAttribute('data-pr-state', 'merged');

	await page.getByRole('link', { name: 'Dashboard' }).click();
	await expect(page.getByText('Open pull requests').locator('..')).toContainText('0');

	await app.close();
	await gh.close();
});

test('saves, uses and deletes instruction templates', async () => {
	const app = await launch();
	const page = await app.firstWindow();
	const repo = createGitHubLikeRepo('acme/widgets');
	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByLabel('Folder path').fill(repo.dir);
	await page.getByRole('button', { name: 'Add', exact: true }).click();

	await page.getByRole('link', { name: 'Agent', exact: true }).click();
	await page
		.getByRole('textbox', { name: 'Message' })
		.fill('Upgrade all dependencies and fix what breaks.');
	await page.getByRole('button', { name: 'Save as template' }).click();
	await page.getByLabel('Template name').fill('Upgrade deps');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Template saved');

	await page.reload();
	await page.getByLabel('Use a template').selectOption({ label: 'Upgrade deps' });
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
		'Upgrade all dependencies and fix what breaks.'
	);

	await page.getByRole('link', { name: 'Settings' }).click();
	await expect(page.getByTestId('templates')).toContainText('Upgrade deps');
	await page.getByRole('button', { name: 'Delete Upgrade deps' }).click();
	await expect(page.getByText('No templates yet.', { exact: false })).toBeVisible();

	await app.close();
});

test('signs in with GitHub and adds a repository by URL', async () => {
	const bare = makeTemp('patchwork-remote-');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
	const seed = createRepo(bare);
	execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });
	const gh = await startFakeGitHub({
		user: { login: 'desk-user' },
		userRepos: [{ fullName: 'acme/listed', description: 'Shown after sign-in' }]
	});
	const app = await launch({
		PATCHWORK_GITHUB_WEB_URL: gh.url,
		PATCHWORK_GITHUB_API_URL: gh.url,
		PATCHWORK_GITHUB_CLIENT_ID: 'Iv23liDeskClient'
	});
	const page = await app.firstWindow();

	await page.getByRole('link', { name: 'Settings' }).click();
	const card = page.getByTestId('github-signin');
	await card.getByRole('button', { name: 'Sign in with GitHub' }).click();
	await expect(card.getByTestId('github-user-code')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	expect(gh.approveDevice()).not.toBeNull();
	await expect(card.getByTestId('github-account')).toHaveText('Signed in as desk-user');

	await page.getByRole('link', { name: 'Repositories' }).click();
	// Desktop opens on local folders; URLs and the GitHub list are one tab over.
	await expect(page.getByRole('tab', { name: 'Local folder' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await page.getByRole('tab', { name: 'From a URL' }).click();
	await expect(page.getByTestId('github-repositories')).toContainText('acme/listed');

	await page.getByLabel('Repository URL').fill(`file://${bare}`);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	const repo = page.getByTestId('repository');
	await expect(repo).toContainText('App copy');
	await expect(repo).toContainText('Not cloned yet');
	await repo.getByRole('button', { name: 'Clone now' }).click();
	await expect(repo).toContainText('On main');

	await app.close();
	await gh.close();
});
