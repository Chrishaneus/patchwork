import path from 'node:path';
import type { Repository, Run, Task } from '#lib/engine/contract.js';
import { collectDiff, createWorktree } from '../git/worktrees.js';
import { performChecks } from './checks.js';
import { addUsage, type RunContext } from './context.js';

/** The prompt for a follow-up: what was asked and done so far, then the new instruction. */
export function followUpPrompt(instruction: string, task: Task, followUp: string): string {
	const parts = [`You already worked on this request in this working copy:\n\n${instruction}`];
	const earlier = (task.followUps ?? []).slice(0, -1);
	if (earlier.length > 0) {
		parts.push(`Earlier follow-ups:\n\n${earlier.map((f) => `- ${f.instruction}`).join('\n')}`);
	}
	if (task.summary) parts.push(`Your summary of the work so far:\n\n${task.summary}`);
	if (task.checks?.status === 'failed') {
		parts.push(
			`The repository's checks (\`${task.checks.command}\`) failed with exit code ${task.checks.exitCode ?? 'unknown'}. End of their output:\n\n\`\`\`\n${task.checks.output.slice(-4000)}\n\`\`\``
		);
	}
	parts.push(`Now do this as well:\n\n${followUp}`);
	parts.push(
		'When you finish, summarize the complete change, including the earlier work: the summary becomes the pull request description.'
	);
	return parts.join('\n\n');
}

/**
 * A change: a worktree on a new branch (or the existing one for a follow-up), the agent, the
 * repository's checks, then the task waits for review.
 */
export async function executeCodeTask(
	ctx: RunContext,
	input: {
		taskId: string;
		task: Task;
		run: Run;
		repo: Repository;
		signal: AbortSignal;
		model: string;
		say: (text: string) => void;
		followUp?: string;
	}
) {
	const { taskId, task, run, repo, signal, say, followUp } = input;
	let worktreePath: string;
	let baseCommit: string;
	if (followUp && task.worktreePath && task.baseCommit) {
		// A follow-up continues in the same working copy.
		({ worktreePath, baseCommit } = task);
		say(`Follow-up: ${followUp}`);
	} else {
		await ctx.updateTask(taskId, { status: 'preparing', startedAt: new Date().toISOString() });
		// Repositories added by URL are cloned the first time a change runs on them.
		const source = await ctx.prepareSource(repo, say);
		if (signal.aborted) throw signal.reason;
		worktreePath = path.join(ctx.deps.worktreesDir, taskId);
		baseCommit = await createWorktree({
			repo: source,
			branch: task.branch,
			worktreePath,
			log: say,
			authEnv: await ctx.authEnvFor(repo)
		});
		await ctx.updateTask(taskId, { worktreePath, baseCommit });
	}
	if (signal.aborted) throw signal.reason;

	await ctx.updateTask(taskId, { status: 'running' });
	const apiKey = await ctx.deps.getApiKey();
	// A cancel can land while we were getting ready; don't start the agent then.
	if (signal.aborted) throw signal.reason;
	const result = await ctx.deps.runAgent({
		cwd: worktreePath,
		instruction: followUp
			? followUpPrompt(run.instruction, await ctx.findTask(taskId), followUp)
			: run.instruction,
		repository: repo,
		branch: task.branch,
		baseBranch: task.baseBranch,
		model: input.model,
		apiKey,
		signal,
		log: (entry) => ctx.log(taskId, entry)
	});
	if (signal.aborted) throw signal.reason;
	const before = await ctx.findTask(taskId);
	await ctx.updateTask(taskId, {
		summary: result.summary,
		// Follow-ups add to the cost and turns of the earlier work.
		costUsd: followUp ? addUsage(before.costUsd, result.costUsd) : result.costUsd,
		turns: followUp ? addUsage(before.turns, result.turns) : result.turns
	});

	const command = (await ctx.findRepository(repo.id))?.checkCommand;
	if (command) {
		const checks = await performChecks(ctx, taskId, worktreePath, command, signal);
		if (!checks) throw signal.reason ?? new Error('Checks stopped');
	}

	const { stat } = await collectDiff(worktreePath, baseCommit);
	say(
		`Finished: ${stat.files} ${stat.files === 1 ? 'file' : 'files'} changed, +${stat.insertions} −${stat.deletions}.`
	);
	await ctx.updateTask(taskId, {
		status: 'awaiting_review',
		finishedAt: new Date().toISOString(),
		diffStat: stat
	});
}
