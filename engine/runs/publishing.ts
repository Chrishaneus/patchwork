import {
	EngineError,
	type EngineErrorData,
	type PublishInput,
	type PullRequest,
	type Task
} from '#lib/engine/contract.js';
import { commitChanges, pushBranch } from '../git/publish.js';
import { removeWorktreeOnly } from '../git/worktrees.js';
import { providerAuthEnv, providerFor, supportsPullRequests } from '../providers/index.js';
import type { RunContext } from './context.js';
import { reviewMarkdown } from './workflows.js';

/**
 * Commit, push and open the pull request. Failures leave the task in review with
 * `publishError` set, so publishing can simply be retried.
 */
export async function publishTask(ctx: RunContext, input: PublishInput): Promise<Task> {
	const title = input.title?.trim();
	const body = (input.body ?? '').trim();
	if (!title) throw new EngineError('invalid_input', 'The pull request needs a title.');
	const task = await ctx.findTask(input.taskId);
	if (task.status !== 'awaiting_review' || !task.worktreePath || !task.baseCommit) {
		throw new EngineError(
			'invalid_state',
			'Only changes that are ready for review can be published.'
		);
	}
	const repo = await ctx.findRepository(task.repositoryId);
	if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');

	// Resolve the provider first: a missing token stops publishing before git is touched.
	const provider = await providerFor(repo, ctx.deps.providers);

	const { worktreePath, baseCommit } = task;
	const say = (text: string) => ctx.log(task.id, { kind: 'info', text });
	await ctx.updateTask(task.id, { status: 'publishing', publishError: null });
	try {
		const commitSha = await commitChanges({
			worktreePath,
			baseCommit,
			message: body ? `${title}\n\n${body}` : title
		});
		say(`Committed ${commitSha.slice(0, 8)}.`);
		await pushBranch({
			worktreePath,
			repo,
			branch: task.branch,
			authEnv: providerAuthEnv(repo.remoteUrl, provider?.kind ?? null, provider?.token ?? null)
		});
		const pushedAt = new Date().toISOString();
		say(`Pushed ${task.branch} to ${repo.remoteName}.`);
		await ctx.updateTask(task.id, { commitSha, pushedAt });

		let pullRequest: PullRequest | null = null;
		if (provider) {
			pullRequest = await provider.openPullRequest({
				slug: repo.slug!,
				head: task.branch,
				base: task.baseBranch,
				title,
				body,
				draft: Boolean(input.draft)
			});
			const label = provider.kind === 'gitlab' ? `merge request !` : `pull request #`;
			say(`Opened ${label}${pullRequest.number}: ${pullRequest.url}`);
		} else {
			say(
				'This remote isn’t on GitHub or GitLab, so no pull request was opened. Open one on your git host.'
			);
		}

		// The branch lives on in the repository and on the remote; the worktree isn't needed anymore.
		await removeWorktreeOnly(repo, worktreePath);
		return await ctx.updateTask(task.id, { status: 'published', pullRequest, worktreePath: null });
	} catch (error) {
		const publishError: EngineErrorData =
			error instanceof EngineError
				? { code: error.code, message: error.message }
				: { code: 'internal', message: error instanceof Error ? error.message : String(error) };
		ctx.log(task.id, { kind: 'error', text: publishError.message });
		return ctx.updateTask(task.id, { status: 'awaiting_review', publishError });
	}
}

/** Post a finished review on its pull request, as a comment. */
export async function postReview(ctx: RunContext, taskId: string): Promise<Task> {
	const task = await ctx.findTask(taskId);
	const run = await ctx.findRun(task.runId);
	if (!task.review || !run?.pullRequest) {
		throw new EngineError('invalid_state', 'Only finished reviews can be posted.');
	}
	if (task.review.postedUrl) return task;
	const repo = await ctx.findRepository(task.repositoryId);
	if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
	const provider = await providerFor(repo, ctx.deps.providers);
	if (!provider || !repo.slug) {
		throw new EngineError('invalid_state', 'This repository is not on GitHub or GitLab.');
	}
	const postedUrl = await provider.comment(
		repo.slug,
		run.pullRequest.number,
		reviewMarkdown(task.review)
	);
	ctx.log(taskId, { kind: 'info', text: `Posted the review: ${postedUrl}` });
	return ctx.updateTask(taskId, { review: { ...task.review, postedUrl } });
}

/** Refresh the state of open pull requests from their providers. */
export async function syncPullRequests(ctx: RunContext): Promise<{ updated: number }> {
	const { runs, repositories } = await ctx.store.read();
	let updated = 0;
	for (const task of runs.flatMap((r) => r.tasks)) {
		const pr = task.pullRequest;
		if (!pr || (pr.state ?? 'open') !== 'open') continue;
		const repo = repositories.find((r) => r.id === task.repositoryId);
		if (!repo || !supportsPullRequests(repo)) continue;
		try {
			const provider = await providerFor(repo, ctx.deps.providers);
			if (!provider) continue;
			const state = await provider.getState(repo.slug!, pr.number);
			const syncedAt = new Date().toISOString();
			await ctx.updateTask(task.id, {
				pullRequest: { ...pr, provider: pr.provider ?? provider.kind, state, syncedAt }
			});
			if (state !== 'open') {
				updated += 1;
				ctx.log(task.id, { kind: 'info', text: `Pull request ${state}.` });
			}
		} catch {
			// No token or the provider is unreachable: try again on the next sync.
		}
	}
	return { updated };
}
