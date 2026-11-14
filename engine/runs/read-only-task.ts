import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
	EngineError,
	type PullRequestReview,
	type Repository,
	type ReviewComment,
	type ReviewedPullRequest,
	type ReviewResult,
	type Run
} from '#lib/engine/contract.js';
import { git, tryGit } from '../git/git.js';
import { removeWorktreeOnly, setWritable } from '../git/worktrees.js';
import { pullRequestRef } from '../providers/index.js';
import { addUsage, type RunContext } from './context.js';
import { anchorComments } from './review-comments.js';
import {
	askFollowUpPrompt,
	askPrompt,
	explorePrompt,
	multiReviewPrompt,
	parseExploration,
	parseMultiReview,
	parseReview,
	readOnlyFollowUpPrompt,
	reviewPrompt,
	type PullRequestInFolder
} from './workflows.js';

/** Remove a read-only task's working copy (or a multi-PR review's copies), if it has any. */
export async function dropWorkingCopy(ctx: RunContext, taskId: string) {
	const task = await ctx.findTask(taskId).catch(() => null);
	if (!task?.worktreePath) return;
	if (task.workingCopies?.length) {
		// The folder holding the copies is read-only too; open it first so they can go.
		const workspace = await stat(task.worktreePath).catch(() => null);
		if (workspace) await chmod(task.worktreePath, workspace.mode | 0o700).catch(() => {});
		for (const copy of task.workingCopies) {
			const repo = await ctx.findRepository(copy.repositoryId);
			if (repo) await removeWorktreeOnly(repo, copy.path);
		}
		await rm(task.worktreePath, { recursive: true, force: true });
		await ctx.updateTask(taskId, { worktreePath: null, workingCopies: [] });
		return;
	}
	const repo = await ctx.findRepository(task.repositoryId);
	if (repo) await removeWorktreeOnly(repo, task.worktreePath);
	await ctx.updateTask(taskId, { worktreePath: null });
}

/** A pull request's head and the commit its changes start from, fetched from its repository. */
async function fetchPullRequest(
	ctx: RunContext,
	repo: Repository,
	pr: ReviewedPullRequest,
	say: (text: string) => void
) {
	const source = await ctx.prepareSource(repo, say);
	const env = await ctx.authEnvFor(repo);
	say(`Fetching pull request #${pr.number}${repo.slug ? ` of ${repo.slug}` : ''}…`);
	const base = await ctx.fetchCommit(source, pr.baseRef, env);
	// The PR's head from the base repository (works for forks too), else its branch.
	const head =
		(await ctx.fetchCommit(source, pullRequestRef(pr.provider, pr.number), env)) ??
		(await ctx.fetchCommit(source, pr.headRef, env));
	if (!base || !head) {
		throw new EngineError(
			'invalid_pull_request',
			`Could not fetch pull request #${pr.number} from ${repo.remoteName}.`
		);
	}
	const baseCommit = (await tryGit(source.path, ['merge-base', base, head])) ?? base;
	return { source, head, baseCommit };
}

/** What a review said, for comparing an updated one: unchanged keeps its posted link. */
const reviewKey = (r: Pick<ReviewResult, 'scores' | 'summary' | 'verdict' | 'comments'>) =>
	JSON.stringify([r.scores, r.summary, r.verdict, plainComments(r.comments)]);

/** Comments as the agent gave them, without what the app added. */
const plainComments = (comments: ReviewComment[] | undefined) =>
	(comments ?? []).map(({ path, startLine, line, body, suggestion }) => ({
		path,
		startLine,
		line,
		body,
		suggestion
	}));

/** A review as the agent last answered it, for a follow-up question. */
function previousReview(review: ReviewResult) {
	const own = (r: Pick<ReviewResult, 'scores' | 'summary' | 'verdict' | 'comments'>) => ({
		scores: r.scores,
		summary: r.summary,
		verdict: r.verdict,
		comments: plainComments(r.comments)
	});
	return review.pullRequests
		? { ...own(review), pullRequests: review.pullRequests.map((p) => ({ url: p.url, ...own(p) })) }
		: own(review);
}

/**
 * Review, explore and ask: a detached working copy (no branch of its own), the agent in
 * read-only mode, and its answer parsed onto the task.
 */
export async function executeReadOnlyTask(
	ctx: RunContext,
	input: {
		taskId: string;
		run: Run;
		repo: Repository;
		signal: AbortSignal;
		model: string;
		say: (text: string) => void;
		followUp?: string;
	}
) {
	const { taskId, run, repo, signal, say, followUp } = input;
	const before = await ctx.findTask(taskId);
	if (followUp) say(`Follow-up: ${followUp}`);
	await ctx.updateTask(taskId, { status: 'preparing', startedAt: new Date().toISOString() });
	if (run.kind === 'review' && (run.pullRequests?.length ?? 0) > 1) {
		return executeMultiReview(ctx, { ...input, before });
	}
	const worktreePath = path.join(ctx.deps.worktreesDir, taskId);

	let source: Awaited<ReturnType<RunContext['prepareSource']>>;
	let head: string;
	let baseCommit: string;
	if (run.kind === 'review') {
		({ source, head, baseCommit } = await fetchPullRequest(ctx, repo, run.pullRequest!, say));
	} else {
		source = await ctx.prepareSource(repo, say);
		if (signal.aborted) throw signal.reason;
		const env = await ctx.authEnvFor(repo);
		say(`Fetching ${repo.remoteName}/${repo.defaultBranch}…`);
		const latest = await ctx.fetchCommit(source, repo.defaultBranch, env);
		if (!latest) {
			say(`Could not fetch ${repo.remoteName}; using the local ${repo.defaultBranch}.`);
		}
		head =
			latest ??
			(await tryGit(source.path, ['rev-parse', '--verify', `${repo.defaultBranch}^{commit}`])) ??
			(await git(source.path, ['rev-parse', 'HEAD']));
		baseCommit = head;
	}
	try {
		await git(source.path, ['worktree', 'add', '--quiet', '--detach', worktreePath, head]);
	} catch (error) {
		throw new EngineError(
			'git_failed',
			`Could not create the working copy: ${(error as Error).message}`
		);
	}
	await ctx.updateTask(taskId, { worktreePath, baseCommit });
	// Read-only on disk too, for agents whose commands can't be sandboxed here.
	await setWritable(worktreePath, false);
	if (signal.aborted) throw signal.reason;

	await ctx.updateTask(taskId, { status: 'running' });
	const apiKey = await ctx.deps.getApiKey(input.model);
	if (signal.aborted) throw signal.reason;
	const original =
		run.kind === 'review'
			? reviewPrompt(run.pullRequest!, run.attributes ?? [], baseCommit, run.focus)
			: run.kind === 'ask'
				? askPrompt(run.instruction)
				: explorePrompt(run.instruction);
	const earlier = (before.followUps ?? []).slice(0, -1).map((f) => f.instruction);
	const previous = before.review ? previousReview(before.review) : before.exploration;
	const result = await ctx.deps.runAgent({
		cwd: worktreePath,
		instruction:
			followUp && run.kind === 'ask' && before.summary
				? askFollowUpPrompt(run.instruction, before.summary, earlier, followUp)
				: followUp && previous
					? readOnlyFollowUpPrompt(original, previous, earlier, followUp)
					: original,
		repository: repo,
		branch: '',
		baseBranch: run.kind === 'review' ? run.pullRequest!.baseRef : repo.defaultBranch,
		model: input.model,
		apiKey,
		signal,
		log: (entry) => ctx.log(taskId, entry),
		requestApproval: (ask) => ctx.approvals.request(taskId, ask, signal),
		mode: run.kind,
		attributes: run.attributes
	});
	if (signal.aborted) throw signal.reason;
	await ctx.updateTask(taskId, {
		costUsd: followUp ? addUsage(before.costUsd, result.costUsd) : result.costUsd,
		turns: followUp ? addUsage(before.turns, result.turns) : result.turns
	});
	// Parse first: an unreadable first answer fails the task (and drops the copy) in execute.
	// A follow-up that only answers a question keeps the earlier report.
	const parse = <T>(fn: () => T, earlier: T | null): T | null => {
		try {
			return fn();
		} catch (error) {
			if (followUp && earlier) return earlier;
			throw error;
		}
	};
	let review =
		run.kind === 'review'
			? parse(() => parseReview(result.summary, run.attributes ?? []), before.review)
			: null;
	const exploration =
		run.kind === 'explore'
			? parse(() => parseExploration(result.summary), before.exploration)
			: null;
	if (review) {
		// The comments' lines as the pull request has them, before the copy goes.
		review = {
			...review,
			headSha: head,
			comments: await anchorComments(worktreePath, baseCommit, head, review.comments ?? [])
		};
	}
	// An unchanged review keeps its posted link; a changed one can be posted again.
	if (review && before.review) {
		review = {
			...review,
			postedUrl: reviewKey(review) === reviewKey(before.review) ? before.review.postedUrl : null
		};
	}
	await dropWorkingCopy(ctx, taskId);

	if (run.kind === 'ask') {
		await ctx.updateTask(taskId, {
			status: 'completed',
			finishedAt: new Date().toISOString(),
			summary: result.summary
		});
	} else if (review) {
		say(`Review finished: ${review.scores.map((s) => `${s.attribute} ${s.score}/5`).join(', ')}.`);
		await ctx.updateTask(taskId, {
			status: 'completed',
			finishedAt: new Date().toISOString(),
			review,
			summary: review.summary
		});
	} else if (exploration) {
		say(`Exploration finished: ${exploration.approaches.length} approaches.`);
		await ctx.updateTask(taskId, {
			status: 'completed',
			finishedAt: new Date().toISOString(),
			exploration,
			summary: exploration.recommendation
		});
	}
}

/**
 * Several related pull requests reviewed together, possibly in different repositories: a folder
 * with one read-only working copy per pull request, one agent over all of them, and a review of
 * each plus the set as a whole.
 */
async function executeMultiReview(
	ctx: RunContext,
	input: {
		taskId: string;
		run: Run;
		repo: Repository;
		signal: AbortSignal;
		model: string;
		say: (text: string) => void;
		followUp?: string;
		before: Awaited<ReturnType<RunContext['findTask']>>;
	}
) {
	const { taskId, run, repo, signal, say, followUp, before } = input;
	const prs = run.pullRequests!;
	const workspace = path.join(ctx.deps.worktreesDir, taskId);
	await mkdir(workspace, { recursive: true });
	const workingCopies: { repositoryId: string; path: string }[] = [];
	const pulls: (PullRequestInFolder & { dir: string; head: string })[] = [];
	const folders = new Set<string>();
	for (const pr of prs) {
		const prRepo = await ctx.findRepository(pr.repositoryId ?? repo.id);
		if (!prRepo) throw new EngineError('repository_not_found', 'A repository was removed.');
		const { source, head, baseCommit } = await fetchPullRequest(ctx, prRepo, pr, say);
		if (signal.aborted) throw signal.reason;
		const stem = `${prRepo.name}-${pr.number}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'pr';
		let folder = stem;
		for (let n = 2; folders.has(folder); n++) folder = `${stem}-${n}`;
		folders.add(folder);
		const dir = path.join(workspace, folder);
		try {
			await git(source.path, ['worktree', 'add', '--quiet', '--detach', dir, head]);
		} catch (error) {
			throw new EngineError(
				'git_failed',
				`Could not create the working copy: ${(error as Error).message}`
			);
		}
		workingCopies.push({ repositoryId: prRepo.id, path: dir });
		await ctx.updateTask(taskId, {
			worktreePath: workspace,
			workingCopies,
			baseCommit: pulls[0]?.baseCommit ?? baseCommit
		});
		await setWritable(dir, false);
		pulls.push({
			pullRequest: pr,
			folder,
			repository: prRepo.slug ?? prRepo.name,
			baseCommit,
			dir,
			head
		});
	}
	// Nothing new in the folder itself either, for agents whose commands can't be sandboxed.
	await chmod(workspace, 0o555);
	if (signal.aborted) throw signal.reason;

	await ctx.updateTask(taskId, { status: 'running' });
	const apiKey = await ctx.deps.getApiKey(input.model);
	if (signal.aborted) throw signal.reason;
	const original = multiReviewPrompt(pulls, run.attributes ?? [], run.focus);
	const earlier = (before.followUps ?? []).slice(0, -1).map((f) => f.instruction);
	const result = await ctx.deps.runAgent({
		cwd: workspace,
		instruction:
			followUp && before.review
				? readOnlyFollowUpPrompt(original, previousReview(before.review), earlier, followUp)
				: original,
		repository: repo,
		branch: '',
		baseBranch: prs[0].baseRef,
		model: input.model,
		apiKey,
		signal,
		log: (entry) => ctx.log(taskId, entry),
		requestApproval: (ask) => ctx.approvals.request(taskId, ask, signal),
		mode: 'review',
		attributes: run.attributes
	});
	if (signal.aborted) throw signal.reason;
	await ctx.updateTask(taskId, {
		costUsd: followUp ? addUsage(before.costUsd, result.costUsd) : result.costUsd,
		turns: followUp ? addUsage(before.turns, result.turns) : result.turns
	});

	let review: ReviewResult;
	try {
		review = parseMultiReview(result.summary, run.attributes ?? [], prs);
	} catch (error) {
		// A follow-up that only answers a question keeps the earlier report.
		if (!(followUp && before.review)) throw error;
		review = before.review;
	}
	if (review !== before.review) {
		const reviewed: PullRequestReview[] = [];
		for (const [i, pr] of (review.pullRequests ?? []).entries()) {
			const { dir, baseCommit, head } = pulls[i];
			const anchored: PullRequestReview = {
				...pr,
				headSha: head,
				comments: await anchorComments(dir, baseCommit, head, pr.comments)
			};
			// An unchanged review keeps its posted link; a changed one can be posted again.
			const earlierReview = before.review?.pullRequests?.find((p) => p.url === pr.url);
			reviewed.push(
				earlierReview && reviewKey(earlierReview) === reviewKey(anchored)
					? { ...anchored, postedUrl: earlierReview.postedUrl }
					: anchored
			);
		}
		review = { ...review, pullRequests: reviewed };
	}
	await dropWorkingCopy(ctx, taskId);
	say(
		`Review finished: ${(review.pullRequests ?? []).map((p) => `#${p.number} ${p.verdict.replace('_', ' ')}`).join(', ')}.`
	);
	await ctx.updateTask(taskId, {
		status: 'completed',
		finishedAt: new Date().toISOString(),
		review,
		summary: review.summary
	});
}
