import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import { startFakeGitHub } from '../../dev/fake-github';
import { guidance, type AgentRunInput, type AgentRunner } from '../agent/runner';
import { createEngine, type Engine } from '../index';
import { createGitHubLikeRepo, run as git, tempDirs } from '../test-helpers';
import { feedbackMarkdown } from './pull-requests';

const dirs = tempDirs();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	dirs.cleanup();
});

function waitFor(engine: Engine, taskId: string, status: Task['status']) {
	return new Promise<Task>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && e.task.status === status) {
				stop();
				resolve(e.task);
			}
		});
	});
}

/**
 * A repository on a fake GitHub with pull request #1 from the branch add-login, and a review on
 * it (#pullrequestreview-1) with a comment on a line.
 */
async function pullRequestWithReview(agent: AgentRunner) {
	const bare = dirs.make('patchwork-remote-');
	const repo = createGitHubLikeRepo(dirs.make(), bare, 'acme/widgets');
	git(repo.dir, 'checkout', '-q', '-b', 'add-login');
	writeFileSync(path.join(repo.dir, 'login.ts'), 'export const login = () => true;\n');
	git(repo.dir, 'add', '.');
	git(repo.dir, 'commit', '-q', '-m', 'Add login');
	git(repo.dir, 'push', '-q', 'origin', 'add-login');
	git(repo.dir, 'checkout', '-q', 'main');
	const prHead = git(repo.dir, 'rev-parse', 'add-login');

	const gh = await startFakeGitHub({ repos: { 'acme/widgets': bare } });
	closers.push(gh.close);
	const api = (method: string, url: string, body: unknown) =>
		fetch(`${gh.url}${url}`, {
			method,
			headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	await api('POST', '/repos/acme/widgets/pulls', {
		title: 'Add login',
		head: 'add-login',
		base: 'main'
	});
	await api('POST', '/repos/acme/widgets/pulls/1/reviews', {
		body: 'Nearly there.',
		event: 'COMMENT',
		comments: [{ path: 'login.ts', line: 1, body: 'Check the password.' }]
	});

	const engine = createEngine({
		dataDir: dirs.make('patchwork-data-'),
		runAgent: agent,
		githubApiUrl: gh.url
	});
	await engine.updateSettings({ githubToken: 'test-token' });
	const added = await engine.addRepository({ path: repo.dir });
	return { engine, repo, gh, prHead, added };
}

describe('addressing a pull request’s review', () => {
	it('works on its branch with the review, then pushes a commit to it', async () => {
		const inputs: AgentRunInput[] = [];
		const agent: AgentRunner = async (input) => {
			inputs.push(input);
			writeFileSync(
				path.join(input.cwd, 'login.ts'),
				'export const login = (password: string) => password.length > 0;\n'
			);
			return {
				summary: 'Title: Check the password on login\n\nLogin now checks the password.',
				costUsd: 0,
				turns: 1
			};
		};
		const { engine, repo, gh, prHead, added } = await pullRequestWithReview(agent);

		const run = await engine.startRun({
			repositoryIds: [],
			instruction: 'Can you address the review please',
			pullRequest: 'https://github.com/acme/widgets/pull/1#pullrequestreview-1'
		});
		expect(run.pullRequest).toMatchObject({ number: 1, headRef: 'add-login', baseRef: 'main' });
		expect(run.tasks[0]).toMatchObject({
			repositoryId: added.id,
			branch: 'add-login',
			baseBranch: 'main'
		});
		const task = await waitFor(engine, run.tasks[0].id, 'awaiting_review');

		// It started from the pull request's latest commit, and the agent got the review.
		expect(task.baseCommit).toBe(prHead);
		expect(task.title).toBe('Check the password on login');
		const prompt = inputs[0].instruction;
		expect(prompt).toContain('Can you address the review please');
		expect(prompt).toContain('Nearly there.');
		expect(prompt).toContain('reviewer on `login.ts` line 1:\n\n> Check the password.');
		expect(inputs[0].pullRequest).toEqual({ provider: 'github', number: 1 });
		expect(guidance(inputs[0])).toContain('of pull request #1');
		// Only the new work is in the diff.
		const diff = await engine.getTaskDiff({ taskId: task.id });
		expect(diff.stat.files).toBe(1);
		expect(diff.patch).toContain('+export const login = (password: string)');

		// A refused reply leaves the change in review, though the commit went out; trying again
		// pushes nothing new and posts the reply.
		gh.refuseReplies(true);
		const refused = await engine.publishTask({
			taskId: task.id,
			title: 'Check the password on login',
			body: 'Login now checks the password.',
			reply: 'Done: login checks the password now.'
		});
		expect(refused).toMatchObject({
			status: 'awaiting_review',
			publishError: { code: 'github_failed' }
		});
		expect(refused.publishError!.message).toContain('GitHub refused the reply (403)');
		expect(gh.replies).toEqual([]);
		const pushed = git(repo.bareDir, 'rev-parse', 'add-login');

		gh.refuseReplies(false);
		const published = await engine.publishTask({
			taskId: task.id,
			title: 'Check the password on login',
			body: 'Login now checks the password.',
			reply: 'Done: login checks the password now.'
		});
		expect(published).toMatchObject({
			status: 'published',
			publishError: null,
			pullRequest: { number: 1, url: `${gh.url}/acme/widgets/pull/1` }
		});
		expect(git(repo.bareDir, 'rev-parse', 'add-login')).toBe(pushed);
		expect(gh.replies).toEqual([
			expect.objectContaining({
				repo: 'acme/widgets',
				number: 1,
				body: `Done: login checks the password now.\n\nChanges: ${pushed}`
			})
		]);
		const log = await engine.getTaskLog({ taskId: task.id });
		expect(log.map((e) => e.text)).toContain(
			`Replied on pull request #1: ${gh.url}/acme/widgets/pull/1#issuecomment-1`
		);
		// No new pull request; the commit is on the pull request's branch, on top of its head.
		expect(gh.pulls).toHaveLength(1);
		expect(git(repo.bareDir, 'log', '-1', '--format=%s', 'add-login')).toBe(
			'Check the password on login'
		);
		expect(git(repo.bareDir, 'rev-parse', 'add-login~1')).toBe(prHead);
		// Your own branch of the same name isn't moved.
		expect(git(repo.dir, 'rev-parse', 'add-login')).toBe(prHead);
	});

	it('takes every review without an anchor', async () => {
		const inputs: AgentRunInput[] = [];
		const agent: AgentRunner = async (input) => {
			inputs.push(input);
			return { summary: 'Title: Nothing\n\nNo change.', costUsd: 0, turns: 1 };
		};
		const { engine, gh } = await pullRequestWithReview(agent);
		const run = await engine.startRun({
			repositoryIds: [],
			instruction: 'fix the review comments',
			pullRequest: 'https://github.com/acme/widgets/pull/1'
		});
		const task = await waitFor(engine, run.tasks[0].id, 'awaiting_review');
		expect(inputs[0].instruction).toContain('Check the password.');
		// Publishing without a reply posts none.
		writeFileSync(path.join(task.worktreePath!, 'notes.md'), 'Notes\n');
		expect(
			await engine.publishTask({ taskId: task.id, title: 'Add notes', body: '' })
		).toMatchObject({ status: 'published' });
		expect(gh.replies).toEqual([]);
	});

	it('keeps your branch when a change to a pull request is discarded', async () => {
		const agent: AgentRunner = async () => ({ summary: 'Title: x\n\ny', costUsd: 0, turns: 1 });
		const { engine, repo, prHead } = await pullRequestWithReview(agent);
		const run = await engine.startRun({
			repositoryIds: [],
			instruction: 'fix the review comments',
			pullRequest: 'https://github.com/acme/widgets/pull/1'
		});
		const task = await waitFor(engine, run.tasks[0].id, 'awaiting_review');
		await engine.discardTask({ taskId: task.id });
		expect(git(repo.dir, 'rev-parse', 'add-login')).toBe(prHead);
	});

	it('refuses a pull request without review comments', async () => {
		const { engine } = await pullRequestWithReview(async () => ({
			summary: '',
			costUsd: 0,
			turns: 1
		}));
		await expect(
			engine.startRun({
				repositoryIds: [],
				instruction: 'address the review',
				pullRequest: 'https://github.com/acme/widgets/pull/1#pullrequestreview-9'
			})
		).rejects.toMatchObject({ code: 'invalid_pull_request' });
	});
});

describe('feedbackMarkdown', () => {
	it('lists each comment with where it is and its replies', () => {
		expect(
			feedbackMarkdown([
				{ author: 'ana', body: 'Looks good overall.' },
				{
					author: 'bo',
					body: 'Rename this.\nIt is unclear.',
					path: 'src/a.ts',
					line: 4,
					replies: [{ author: 'cy', body: 'Agreed.' }]
				}
			])
		).toBe(
			[
				'1. ana:',
				'> Looks good overall.',
				'2. bo on `src/a.ts` line 4:',
				'> Rename this.\n> It is unclear.',
				'Reply from cy:',
				'> Agreed.'
			].join('\n\n')
		);
	});
});
