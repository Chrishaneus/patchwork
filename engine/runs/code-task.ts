import path from 'node:path';
import { PULL_REQUEST_FORMAT } from '../agent/runner.js';
import type { Repository, Run, Task } from '#lib/engine/contract.js';
import { tryGit } from '../git/git.js';
import {
	collectDiff,
	createPullRequestWorktree,
	createSquashWorktree,
	createWorktree
} from '../git/worktrees.js';
import { performChecks } from './checks.js';
import { addUsage, type RunContext } from './context.js';

/** The messages of the commits a squash replaces, oldest first; empty when it isn't one. */
async function squashedMessages(
	worktreePath: string,
	baseCommit: string,
	head: string | null | undefined
): Promise<string[]> {
	if (!head) return [];
	const log = await tryGit(worktreePath, [
		'log',
		'--reverse',
		'--format=%B%x00',
		`${baseCommit}..${head}`
	]);
	return (log ?? '')
		.split('\0')
		.map((message) => message.trim())
		.filter(Boolean);
}

/**
 * The first prompt for a change to a pull request: what the person asked, then, for a squash,
 * the messages of its commits, and its review comments when there are some to address.
 */
export function pullRequestPrompt(run: Run, squashed: string[] = []): string {
	const pr = run.pullRequest!;
	const label =
		pr.provider === 'gitlab' ? `merge request !${pr.number}` : `pull request #${pr.number}`;
	const parts = [run.instruction];
	if (run.squash) {
		parts.push(
			`This is about ${label}, "${pr.title}" (${pr.url}). Its commits are being squashed into one: the working copy is at the commit its branch started from, with the changes of all its commits in place, uncommitted. Their messages, oldest first:`,
			squashed.length > 0
				? squashed.map((message, i) => `${i + 1}.\n\n${message}`).join('\n\n')
				: '(unknown)',
			run.reviewFeedback
				? 'The squashed commit’s message must describe the whole change, not each commit. Its review comments are below.'
				: 'Write the message of the squashed commit: what the whole change does and why, not a list of the commits. Leave the files as they are, unless the request above asks for more than the squash.'
		);
	} else {
		parts.push(
			`This is about ${label}, "${pr.title}" (${pr.url}). You are on its branch, at its latest commit; your change is added to it as a new commit.`
		);
	}
	if (run.reviewFeedback) {
		parts.push(
			'Its review comments:',
			run.reviewFeedback,
			'Make the changes they ask for, as far as the request above goes. Some may already be done in the code, or no longer apply; check the code first, and skip those. If you disagree with a comment, leave the code as it is and say why in the commit description.'
		);
	}
	return parts.join('\n\n');
}

/** The prompt for a follow-up: what was asked and done so far, then the new instruction. */
export function followUpPrompt(
	instruction: string,
	task: Task,
	followUp: string,
	run?: Run
): string {
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
		run?.pullRequest
			? 'When you finish, write the commit again for the complete change, the earlier work included.'
			: 'When you finish, write the pull request again for the complete change, the earlier work included.'
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
		const prepare = {
			repo: source,
			branch: task.branch,
			worktreePath,
			log: say,
			authEnv: await ctx.authEnvFor(repo)
		};
		if (run.pullRequest && run.squash) {
			// A squash starts where the pull request's branch started, with all its changes staged.
			const squashed = await createSquashWorktree({ ...prepare, baseBranch: task.baseBranch });
			baseCommit = squashed.baseCommit;
			await ctx.updateTask(taskId, { worktreePath, baseCommit, squashedFrom: squashed.head });
		} else {
			// A change to a pull request starts from its branch's latest commit, without a branch of its own.
			baseCommit = await (run.pullRequest ? createPullRequestWorktree : createWorktree)(prepare);
			await ctx.updateTask(taskId, { worktreePath, baseCommit });
		}
	}
	if (signal.aborted) throw signal.reason;
	// Every time, as a follow-up may have changed the Playwright version; quick once installed.
	const env = await ctx.testBrowsersEnv(taskId, worktreePath, signal);
	if (signal.aborted) throw signal.reason;

	await ctx.updateTask(taskId, { status: 'running' });
	const apiKey = await ctx.deps.getApiKey(input.model);
	// A cancel can land while we were getting ready; don't start the agent then.
	if (signal.aborted) throw signal.reason;
	const current = await ctx.findTask(taskId);
	const original = run.pullRequest
		? pullRequestPrompt(run, await squashedMessages(worktreePath, baseCommit, current.squashedFrom))
		: run.instruction;
	const result = await ctx.deps.runAgent({
		cwd: worktreePath,
		instruction:
			switched ?? (followUp ? followUpPrompt(original, current, followUp, run) : original),
		...(run.pullRequest
			? {
					pullRequest: {
						provider: run.pullRequest.provider,
						number: run.pullRequest.number,
						...(run.squash ? { squash: true } : {})
					}
				}
			: {}),
		repository: repo,
		branch: task.branch,
		baseBranch: task.baseBranch,
		model: input.model,
		apiKey,
		signal,
		log: (entry) => ctx.log(taskId, entry),
		requestApproval: (ask) => ctx.approvals.request(taskId, ask, signal),
		env
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
