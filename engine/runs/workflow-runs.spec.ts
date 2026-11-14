import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunInput } from '../agent/runner';
import type { Task } from '#lib/engine/contract.js';
import { startFakeGitHub, type FakeGitHub } from '../../dev/fake-github';
import type { AgentRunner } from '../agent/runner';
import { createEngine, createTestAgent, type Engine } from '../index';
import { createGitHubLikeRepo, run as git, tempDirs } from '../test-helpers';
import { defaultReviewAttributes } from './workflows';

const dirs = tempDirs();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	dirs.cleanup();
});

const attributes = [
	{ id: 'security', name: 'Security', description: 'No secrets or injection.' },
	{ id: 'minimalism', name: 'Minimalism', description: 'No more code than needed.' }
];

function waitFor(engine: Engine, taskId: string, statuses: Task['status'][]) {
	return new Promise<Task>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status)) {
				stop();
				resolve(e.task);
			}
		});
	});
}

/** A GitHub-like repository with an open pull request (branch `feature` adds feature.txt). */
async function withPullRequest(agent: AgentRunner) {
	const bare = dirs.make('patchwork-remote-');
	const repo = createGitHubLikeRepo(dirs.make(), bare, 'acme/widgets');
	// Someone else's branch, pushed to the remote only.
	const other = dirs.make('patchwork-other-');
	git(other, 'clone', '-q', bare, '.');
	git(other, 'config', 'user.email', 'dev@example.com');
	git(other, 'config', 'user.name', 'Dev');
	git(other, 'switch', '-q', '-c', 'feature');
	writeFileSync(path.join(other, 'feature.txt'), 'new feature\n');
	git(other, 'add', '.');
	git(other, 'commit', '-q', '-m', 'Add feature');
	git(other, 'push', '-q', 'origin', 'feature');

	const gh: FakeGitHub = await startFakeGitHub({ repos: { 'acme/widgets': bare } });
	closers.push(gh.close);
	const res = await fetch(`${gh.url}/repos/acme/widgets/pulls`, {
		method: 'POST',
		headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'Add a feature', head: 'feature', base: 'main' })
	});
	expect(res.status).toBe(201);

	const engine = createEngine({
		dataDir: dirs.make('patchwork-data-'),
		runAgent: agent,
		githubApiUrl: gh.url
	});
	await engine.updateSettings({ githubToken: 'test-token' });
	const added = await engine.addRepository({ path: repo.dir });
	return { engine, gh, repo, added };
}

describe('review workflow', () => {
	it('reviews a pull request read-only, scores it and posts the review', async () => {
		let seen: AgentRunInput | null = null;
		let featureFile: string | null = null;
		const scripted = createTestAgent('edit');
		const agent: AgentRunner = async (input) => {
			seen = input;
			featureFile = readFileSync(path.join(input.cwd, 'feature.txt'), 'utf8');
			return scripted(input);
		};
		const { engine, gh, repo, added } = await withPullRequest(agent);

		const open = await engine.listPullRequests({ repositoryId: added.id });
		expect(open).toMatchObject([
			{ number: 1, title: 'Add a feature', headRef: 'feature', baseRef: 'main' }
		]);

		const run = await engine.startReview({ repositoryId: added.id, number: 1, attributes });
		expect(run).toMatchObject({ kind: 'review', pullRequest: { number: 1, headRef: 'feature' } });
		const task = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);

		expect(task.error).toBeNull();
		expect(task.status).toBe('completed');
		expect(seen!.mode).toBe('review');
		expect(seen!.instruction).toContain(`git diff ${task.baseCommit}...HEAD`);
		expect(featureFile).toBe('new feature\n');
		expect(task.review).toMatchObject({
			verdict: 'comment',
			postedUrl: null,
			scores: [
				{ attribute: 'Security', score: 5 },
				{ attribute: 'Minimalism', score: 4 }
			]
		});
		// The working copy is gone and no branch was made in your repository.
		expect(task.worktreePath).toBeNull();
		expect(existsSync(seen!.cwd)).toBe(false);
		expect(git(repo.dir, 'branch', '--list')).not.toContain('feature');

		// The suggestion is on a line the pull request adds, with that line as it is there.
		expect(task.review!.comments).toEqual([
			{
				path: 'feature.txt',
				startLine: 1,
				line: 1,
				body: 'Say it louder.',
				suggestion: 'NEW FEATURE',
				original: 'new feature',
				inDiff: true
			}
		]);
		expect(task.review!.headSha).toMatch(/^[0-9a-f]{40}$/);

		const posted = await engine.postReview({ taskId: task.id });
		expect(posted.review!.postedUrl).toBe(`${gh.url}/acme/widgets/pull/1#pullrequestreview-1`);
		expect(gh.reviews).toHaveLength(1);
		expect(gh.reviews[0].body).toContain('| Security | ★★★★★ 5/5 |');
		expect(gh.reviews[0]).toMatchObject({
			commit_id: task.review!.headSha,
			comments: [
				{
					path: 'feature.txt',
					line: 1,
					side: 'RIGHT',
					body: 'Say it louder.\n\n```suggestion\nNEW FEATURE\n```'
				}
			]
		});
		// Posting twice doesn't post twice.
		await engine.postReview({ taskId: task.id });
		expect(gh.reviews).toHaveLength(1);
	});

	it('finds the repository from a pull request link', async () => {
		const { engine, added } = await withPullRequest(createTestAgent('edit'));
		const run = await engine.startReview({
			url: 'https://github.com/acme/widgets/pull/1',
			attributes
		});
		expect(run.tasks[0].repositoryId).toBe(added.id);
		const task = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);
		expect(task.status).toBe('completed');
		// Discarding a finished review is fine and never deletes a branch.
		await engine.discardTask({ taskId: task.id });
	});

	it('fails clearly when the agent answers without a readable review', async () => {
		const { engine, added } = await withPullRequest(async () => ({
			summary: 'Looks good to me!',
			costUsd: 0,
			turns: 1
		}));
		const run = await engine.startReview({ repositoryId: added.id, number: 1, attributes });
		const task = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);
		expect(task).toMatchObject({ status: 'failed', error: { code: 'unreadable_result' } });
		expect(task.worktreePath).toBeNull();
	});

	it('rejects bad input before starting', async () => {
		const { engine, added } = await withPullRequest(createTestAgent('edit'));
		await expect(
			engine.startReview({ repositoryId: added.id, number: 1, attributes: [] })
		).rejects.toMatchObject({ code: 'invalid_input' });
		await expect(
			engine.startReview({ url: 'https://example.com/nope', attributes })
		).rejects.toMatchObject({ code: 'invalid_pull_request' });
		await expect(
			engine.startReview({ repositoryId: added.id, number: 99, attributes })
		).rejects.toMatchObject({ code: 'invalid_pull_request' });
	});
});

describe('follow-ups on reviews', () => {
	it('answers questions in a fresh read-only copy and keeps the report', async () => {
		const prompts: string[] = [];
		const scripted = createTestAgent('edit');
		let answerWithJson = true;
		const agent: AgentRunner = async (input) => {
			prompts.push(input.instruction);
			if (!answerWithJson) {
				const summary = 'Security is fine: no input reaches a shell.';
				input.log({ kind: 'result', text: summary });
				return { summary, costUsd: 0.01, turns: 1 };
			}
			return scripted(input);
		};
		const { engine, added } = await withPullRequest(agent);
		const run = await engine.startReview({
			url: 'https://github.com/acme/widgets/pull/1',
			instruction: 'https://github.com/acme/widgets/pull/1 please focus on error handling',
			attributes
		});
		expect(run.instruction).toBe(
			'https://github.com/acme/widgets/pull/1 please focus on error handling'
		);
		expect(run.tasks[0].repositoryId).toBe(added.id);
		const first = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);
		expect(prompts[0]).toContain('The person asking adds: please focus on error handling');

		// A question the agent answers without new JSON keeps the earlier report.
		answerWithJson = false;
		await engine.followUpTask({ taskId: first.id, instruction: 'Is the security score right?' });
		const second = await waitFor(engine, first.id, ['completed', 'failed']);
		expect(second.status).toBe('completed');
		expect(second.review).toEqual(first.review);
		expect(second.followUps).toHaveLength(1);
		expect(second.costUsd).toBeCloseTo((first.costUsd ?? 0) + 0.01);
		expect(second.worktreePath).toBeNull();
		expect(prompts[1]).toContain('Now the person asks: Is the security score right?');
		expect(prompts[1]).toContain('"verdict": "comment"');
		const log = await engine.getTaskLog({ taskId: first.id });
		expect(log.map((e) => e.text)).toContain('Security is fine: no input reaches a shell.');

		// Code-run rules don't apply: there is no working copy to keep.
		await expect(engine.followUpTask({ taskId: first.id, instruction: ' ' })).rejects.toMatchObject(
			{ code: 'invalid_input' }
		);
	});
});

describe('explore workflow', () => {
	it('compares approaches without changing the repository', async () => {
		const { engine, repo, added } = await withPullRequest(createTestAgent('edit'));
		const before = git(repo.dir, 'status', '--porcelain');
		const run = await engine.startExplore({ repositoryIds: [added.id], idea: 'Add caching' });
		expect(run.kind).toBe('explore');
		const task = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);
		expect(task.status).toBe('completed');
		expect(task.exploration!.approaches.length).toBeGreaterThanOrEqual(2);
		expect(task.summary).toBe(task.exploration!.recommendation);
		expect(task.worktreePath).toBeNull();
		expect(git(repo.dir, 'status', '--porcelain')).toBe(before);
	});
});

describe('review attributes setting', () => {
	it('defaults to the built-in list and can be changed', async () => {
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			runAgent: createTestAgent('edit')
		});
		expect((await engine.getSettings({})).reviewAttributes).toEqual(defaultReviewAttributes);
		const updated = await engine.updateSettings({
			reviewAttributes: [
				{ id: '', name: ' Accessibility ', description: 'Keyboard and screen readers.' }
			]
		});
		expect(updated.reviewAttributes).toEqual([
			{ id: 'accessibility', name: 'Accessibility', description: 'Keyboard and screen readers.' }
		]);
		await expect(engine.updateSettings({ reviewAttributes: [] })).rejects.toMatchObject({
			code: 'invalid_input'
		});
	});
});

describe('ask workflow', () => {
	it('answers a question read-only, without a branch, and takes follow-ups', async () => {
		const prompts: string[] = [];
		const scripted = createTestAgent('edit');
		const writes: string[] = [];
		const { engine, repo, added } = await withPullRequest(async (input) => {
			prompts.push(input.instruction);
			expect(input.mode).toBe('ask');
			// The copy is read-only on disk, for agents whose commands can't be sandboxed.
			for (const target of ['README.md', 'new.txt']) {
				try {
					writeFileSync(path.join(input.cwd, target), 'changed\n');
					writes.push(target);
				} catch {
					// Expected.
				}
			}
			return scripted(input);
		});
		const branches = git(repo.dir, 'branch', '--list');
		const run = await engine.startAsk({
			repositoryIds: [added.id],
			question: 'Can you explain what widgets is?'
		});
		expect(run.kind).toBe('ask');
		const task = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);
		expect(task).toMatchObject({ status: 'completed', worktreePath: null, error: null });
		expect(task.summary).toContain('Can you explain what widgets is?');
		expect(git(repo.dir, 'branch', '--list')).toBe(branches);
		expect(writes).toEqual(process.platform === 'win32' ? ['new.txt'] : []);
		expect(git(repo.dir, 'worktree', 'list').split('\n')).toHaveLength(1);

		await engine.followUpTask({ taskId: task.id, instruction: 'And how is it tested?' });
		const again = await waitFor(engine, task.id, ['completed', 'failed']);
		expect(again.status).toBe('completed');
		expect(prompts[1]).toContain(`Your latest answer was:\n\n${task.summary}`);
		expect(prompts[1]).toContain('Now: And how is it tested?');

		await expect(
			engine.startAsk({ repositoryIds: [added.id], question: ' ' })
		).rejects.toMatchObject({
			code: 'invalid_input'
		});
	});
});

/** Another repository on the same fake GitHub, with a pull request adding `file`. */
function addRepoWithPullRequest(repos: Record<string, string>, slug: string, file: string) {
	const bare = dirs.make('patchwork-remote-');
	const repo = createGitHubLikeRepo(dirs.make(), bare, slug);
	const other = dirs.make('patchwork-other-');
	git(other, 'clone', '-q', bare, '.');
	git(other, 'config', 'user.email', 'dev@example.com');
	git(other, 'config', 'user.name', 'Dev');
	git(other, 'switch', '-q', '-c', 'part');
	writeFileSync(path.join(other, file), `${slug} part\n`);
	git(other, 'add', '.');
	git(other, 'commit', '-q', '-m', `Add ${file}`);
	git(other, 'push', '-q', 'origin', 'part');
	repos[slug] = bare;
	return repo;
}

describe('reviewing several pull requests together', () => {
	it('reviews related pull requests in different repositories as one, and posts each', async () => {
		const repos: Record<string, string> = {};
		const api = addRepoWithPullRequest(repos, 'acme/api', 'api.txt');
		const web = addRepoWithPullRequest(repos, 'acme/web', 'web.txt');
		const gh = await startFakeGitHub({ repos });
		closers.push(gh.close);
		for (const slug of ['acme/api', 'acme/web']) {
			const res = await fetch(`${gh.url}/repos/${slug}/pulls`, {
				method: 'POST',
				headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
				body: JSON.stringify({ title: `${slug} part`, head: 'part', base: 'main' })
			});
			expect(res.status).toBe(201);
		}
		let seen: AgentRunInput | null = null;
		const folders: string[] = [];
		const scripted = createTestAgent('edit');
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			runAgent: async (input) => {
				seen = input;
				const { readdirSync } = await import('node:fs');
				folders.push(...readdirSync(input.cwd));
				return scripted(input);
			},
			githubApiUrl: gh.url
		});
		await engine.updateSettings({ githubToken: 'test-token' });
		const apiRepo = await engine.addRepository({ path: api.dir });
		await engine.addRepository({ path: web.dir });

		const run = await engine.startReview({
			pullRequests: [
				{ url: 'https://github.com/acme/api/pull/1' },
				{ url: 'https://github.com/acme/web/pull/1' },
				// The same one twice counts once.
				{ url: 'https://github.com/acme/api/pull/1' }
			],
			attributes,
			instruction: 'make sure the API and web agree'
		});
		expect(run.tasks).toHaveLength(1);
		expect(run.tasks[0].repositoryId).toBe(apiRepo.id);
		expect(run.pullRequests?.map((p) => p.url)).toEqual([
			`${gh.url}/acme/api/pull/1`,
			`${gh.url}/acme/web/pull/1`
		]);
		const task = await waitFor(engine, run.tasks[0].id, ['completed', 'failed']);
		expect(task.error).toBeNull();

		// One agent saw both working copies, each at its pull request's head.
		expect(folders.sort()).toEqual(['api-1', 'web-1']);
		expect(seen!.instruction).toMatch(/Review these 2 related pull requests together/);
		expect(seen!.instruction).toContain('make sure the API and web agree');
		expect(existsSync(seen!.cwd)).toBe(false);
		expect(task.worktreePath).toBeNull();

		const review = task.review!;
		expect(review.summary).toBe('The pull requests fit together.');
		expect(review.pullRequests).toMatchObject([
			{
				number: 1,
				url: `${gh.url}/acme/api/pull/1`,
				comments: [{ path: 'api.txt', original: 'acme/api part', inDiff: true }]
			},
			{
				number: 1,
				url: `${gh.url}/acme/web/pull/1`,
				comments: [{ path: 'web.txt', original: 'acme/web part', inDiff: true }]
			}
		]);

		// Post one, then the rest: each pull request gets its own review in its own repository.
		const first = await engine.postReview({
			taskId: task.id,
			url: `${gh.url}/acme/web/pull/1`
		});
		expect(first.review!.pullRequests![1].postedUrl).toContain('/acme/web/pull/1#');
		expect(first.review!.pullRequests![0].postedUrl).toBeNull();
		const all = await engine.postReview({ taskId: task.id });
		expect(all.review!.pullRequests!.every((p) => p.postedUrl)).toBe(true);
		expect(gh.reviews.map((r) => r.repo)).toEqual(['acme/web', 'acme/api']);
		expect(gh.reviews[0].body).toContain(`Reviewed together with ${gh.url}/acme/api/pull/1.`);
		expect(gh.reviews[1].comments).toMatchObject([{ path: 'api.txt', line: 1 }]);
		// Nothing is posted twice.
		await engine.postReview({ taskId: task.id });
		expect(gh.reviews).toHaveLength(2);
	});

	it('refuses more than six pull requests', async () => {
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-') });
		await expect(
			engine.startReview({
				pullRequests: Array.from({ length: 7 }, (_, i) => ({
					url: `https://github.com/acme/api/pull/${i + 1}`
				})),
				attributes
			})
		).rejects.toMatchObject({ code: 'invalid_input' });
	});
});
