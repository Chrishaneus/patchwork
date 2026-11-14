import path from 'node:path';
import { PULL_REQUEST_FORMAT } from '../agent/runner.js';
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
		'When you finish, write the pull request again for the complete change, the earlier work included.'
	);
	return parts.join('\n\n');
}

/**
 * The agent's last message as a pull request: the title from its `Title:` line, and the rest
 * after it as the description. Without one, there's no title and the whole message is the
 * description, as before.
 */
export function splitTitle(message: string): { title: string | null; body: string } {
	const lines = message.split('\n');
	// "Title:", "**Title:**" or "**Title**:", with the colon: "Title bar now hides" is no title.
	const label = /^\s*(?:\*\*)?title(?:\*\*)?:(?:\*\*)?\s*/i;
	const at = lines.findIndex((line) => label.test(line));
	if (at === -1) return { title: null, body: message.trim() };
	const title = lines[at]
		.replace(label, '')
		.replace(/^[`"'*]+|[`"'*]+$/g, '')
		.trim()
		.slice(0, 120);
	return {
		title: title || null,
		body: lines
			.slice(at + 1)
			.join('\n')
			.trim()
	};
}

/**
 * The first prompt after a question or exploration becomes a change: what was asked and found,
 * read-only, then the change to make now.
 */
export function switchPrompt(run: Run, task: Task, change: string): string {
	const parts = [
		run.kind === 'explore'
			? `Earlier you explored this idea in this repository, without changing files:\n\n${run.instruction}`
			: `Earlier you were asked about this repository and answered without changing files:\n\n${run.instruction}`
	];
	const earlier = task.followUps ?? [];
	if (earlier.length > 0) {
		parts.push(`Then:\n\n${earlier.map((f) => `- ${f.instruction}`).join('\n')}`);
	}
	if (task.exploration) {
		parts.push(
			`What you found:\n\n\`\`\`json\n${JSON.stringify(task.exploration, null, 2)}\n\`\`\``
		);
	} else if (task.summary) {
		parts.push(`Your latest answer was:\n\n${task.summary}`);
	}
	parts.push(`Now make this change in this working copy; you can edit files now:\n\n${change}`);
	parts.push(PULL_REQUEST_FORMAT);
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
		/** The prompt when a question or exploration just became this change. */
		switched?: string;
	}
) {
	const { taskId, task, run, repo, signal, say, followUp, switched } = input;
	let worktreePath: string;
	let baseCommit: string;
	if (followUp && task.worktreePath && task.baseCommit) {
		// A follow-up continues in the same working copy.
		({ worktreePath, baseCommit } = task);
		say(`Follow-up: ${followUp}`);
	} else {
		if (switched) say(`Switching to a change on the branch ${task.branch}.`);
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
	const apiKey = await ctx.deps.getApiKey(input.model);
	// A cancel can land while we were getting ready; don't start the agent then.
	if (signal.aborted) throw signal.reason;
	const result = await ctx.deps.runAgent({
		cwd: worktreePath,
		instruction:
			switched ??
			(followUp
				? followUpPrompt(run.instruction, await ctx.findTask(taskId), followUp)
				: run.instruction),
		repository: repo,
		branch: task.branch,
		baseBranch: task.baseBranch,
		model: input.model,
		apiKey,
		signal,
		log: (entry) => ctx.log(taskId, entry),
		requestApproval: (ask) => ctx.approvals.request(taskId, ask, signal)
	});
	if (signal.aborted) throw signal.reason;
	const before = await ctx.findTask(taskId);
	const { title, body } = splitTitle(result.summary);
	await ctx.updateTask(taskId, {
		// The description, without the title line; the title is offered when publishing.
		summary: body || result.summary,
		title,
		// Follow-ups (and the conversation before a switch) add to the earlier cost and turns.
		costUsd: followUp || switched ? addUsage(before.costUsd, result.costUsd) : result.costUsd,
		turns: followUp || switched ? addUsage(before.turns, result.turns) : result.turns
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
