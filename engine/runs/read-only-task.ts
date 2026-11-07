import path from 'node:path';
import { EngineError, type Repository, type ReviewResult, type Run } from '#lib/engine/contract.js';
import { git, tryGit } from '../git/git.js';
import { removeWorktreeOnly } from '../git/worktrees.js';
import { pullRequestRef } from '../providers/index.js';
import { addUsage, type RunContext } from './context.js';
import {
	askFollowUpPrompt,
	askPrompt,
	explorePrompt,
	parseExploration,
	parseReview,
	readOnlyFollowUpPrompt,
	reviewPrompt
} from './workflows.js';

/** Remove a read-only task's working copy, if it has one. */
export async function dropWorkingCopy(ctx: RunContext, taskId: string) {
	const task = await ctx.findTask(taskId).catch(() => null);
	if (!task?.worktreePath) return;
	const repo = await ctx.findRepository(task.repositoryId);
	if (repo) await removeWorktreeOnly(repo, task.worktreePath);
	await ctx.updateTask(taskId, { worktreePath: null });
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
	const source = await ctx.prepareSource(repo, say);
	if (signal.aborted) throw signal.reason;
	const env = await ctx.authEnvFor(repo);
	const worktreePath = path.join(ctx.deps.worktreesDir, taskId);

	let head: string;
	let baseCommit: string;
	if (run.kind === 'review') {
		const pr = run.pullRequest!;
		say(`Fetching pull request #${pr.number}…`);
		const base = await ctx.fetchCommit(source, pr.baseRef, env);
		// The PR's head from the base repository (works for forks too), else its branch.
		const fetchedHead =
			(await ctx.fetchCommit(source, pullRequestRef(pr.provider, pr.number), env)) ??
			(await ctx.fetchCommit(source, pr.headRef, env));
		if (!base || !fetchedHead) {
			throw new EngineError(
				'invalid_pull_request',
				`Could not fetch pull request #${pr.number} from ${repo.remoteName}.`
			);
		}
		head = fetchedHead;
		baseCommit = (await tryGit(source.path, ['merge-base', base, head])) ?? base;
	} else {
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
	if (signal.aborted) throw signal.reason;

	await ctx.updateTask(taskId, { status: 'running' });
	const apiKey = await ctx.deps.getApiKey();
	if (signal.aborted) throw signal.reason;
	const original =
		run.kind === 'review'
			? reviewPrompt(run.pullRequest!, run.attributes ?? [], baseCommit, run.focus)
			: run.kind === 'ask'
				? askPrompt(run.instruction)
				: explorePrompt(run.instruction);
	const earlier = (before.followUps ?? []).slice(0, -1).map((f) => f.instruction);
	const previous = before.review
		? {
				scores: before.review.scores,
				summary: before.review.summary,
				verdict: before.review.verdict
			}
		: before.exploration;
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
	// An unchanged review keeps its posted link; a changed one can be posted again.
	if (review && before.review) {
		const same = (r: ReviewResult) => JSON.stringify([r.scores, r.summary, r.verdict]);
		review = {
			...review,
			postedUrl: same(review) === same(before.review) ? before.review.postedUrl : null
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
