import path from 'node:path';
import type { Repository, Run, Task } from '#lib/engine/contract.js';
import type { WorkingCopy } from '../agent/runner.js';
import { collectDiff, createWorktree } from '../git/worktrees.js';
import { performChecks } from './checks.js';
import { splitTitle } from './code-task.js';
import { addUsage, type RunContext } from './context.js';

/** A pull request the agent wrote for one repository: its title and description. */
export interface PullRequestText {
	title: string | null;
	body: string;
}

/**
 * The agent's last message in a change across repositories, split into each repository's pull
 * request: sections starting "Repository: <folder>". Folders it doesn't name aren't in the map.
 * Without any such section, the whole message is everyone's (`all`).
 */
export function splitPullRequests(
	message: string,
	folders: string[]
): { byFolder: Map<string, PullRequestText>; all: PullRequestText | null } {
	const label = /^\s*(?:\*\*)?repository(?:\*\*)?:(?:\*\*)?\s*`?([^`\s*]+?)\/?`?\s*(?:\*\*)?\s*$/i;
	const lines = message.split('\n');
	const starts = lines.flatMap((line, i) => {
		const folder = label.exec(line)?.[1];
		return folder ? [{ i, folder }] : [];
	});
	const byFolder = new Map<string, PullRequestText>();
	if (starts.length === 0) return { byFolder, all: splitTitle(message) };
	starts.forEach(({ i, folder }, n) => {
		const end = starts[n + 1]?.i ?? lines.length;
		const known = folders.find((f) => f.toLowerCase() === folder.toLowerCase());
		if (known) byFolder.set(known, splitTitle(lines.slice(i + 1, end).join('\n')));
	});
	return { byFolder, all: null };
}

/** Folder names for the working copies: each repository's name, made unique. */
export function folderNames(repos: Repository[]): string[] {
	const used = new Set<string>();
	return repos.map((repo) => {
		const stem = repo.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'repository';
		let folder = stem;
		for (let n = 2; used.has(folder); n++) folder = `${stem}-${n}`;
		used.add(folder);
		return folder;
	});
}

/** A follow-up in a change across repositories: the request, the work so far, the new ask. */
export function togetherFollowUpPrompt(run: Run, lead: Task, followUp: string): string {
	const parts = [
		`You already worked on this change across these repositories:\n\n${run.instruction}`
	];
	const earlier = (lead.followUps ?? []).slice(0, -1);
	if (earlier.length > 0) {
		parts.push(`Earlier follow-ups:\n\n${earlier.map((f) => `- ${f.instruction}`).join('\n')}`);
	}
	const summaries = run.tasks
		.filter((t) => t.summary)
		.map((t) => `${t.repositoryName}: ${t.title ? `${t.title}\n\n` : ''}${t.summary}`);
	if (summaries.length > 0)
		parts.push(`Your pull requests so far:\n\n${summaries.join('\n\n---\n\n')}`);
	const failed = run.tasks.filter((t) => t.checks?.status === 'failed');
	for (const task of failed) {
		parts.push(
			`${task.repositoryName}'s checks (\`${task.checks!.command}\`) failed. End of their output:\n\n\`\`\`\n${task.checks!.output.slice(-3000)}\n\`\`\``
		);
	}
	parts.push(`Now do this as well:\n\n${followUp}`);
	parts.push(
		'When you finish, write the pull requests again for the complete change, the earlier work included.'
	);
	return parts.join('\n\n');
}

/**
 * One change across a run's repositories, by one agent: a folder with a worktree per repository
 * (each on its own branch, as a task of its own), the agent working on all of them, then each
 * repository's checks and diff, and its own pull request text from the agent's last message.
 * Run by the run's first task; it updates every task.
 */
export async function executeTogether(
	ctx: RunContext,
	input: {
		run: Run;
		signal: AbortSignal;
		model: string;
		followUp?: string;
	}
) {
	const { run, signal, followUp } = input;
	const lead = run.tasks[0];
	const say = (taskId: string, text: string) => ctx.log(taskId, { kind: 'info', text });
	const workspace = path.join(ctx.deps.worktreesDir, run.id);

	const repos: Repository[] = [];
	for (const task of run.tasks) {
		const repo = await ctx.findRepository(task.repositoryId);
		if (!repo) throw new Error(`The repository ${task.repositoryName} was removed.`);
		repos.push(repo);
	}
	const folders = folderNames(repos);
	const copies: WorkingCopy[] = [];
	const startedAt = new Date().toISOString();
	for (const [i, task] of run.tasks.entries()) {
		const repo = repos[i];
		let copyPath: string;
		if (followUp && task.worktreePath && task.baseCommit) {
			// A follow-up continues in the same working copies.
			copyPath = task.worktreePath;
		} else {
			await ctx.updateTask(task.id, { status: 'preparing', startedAt });
			const source = await ctx.prepareSource(repo, (text) => say(task.id, text));
			if (signal.aborted) throw signal.reason;
			copyPath = path.join(workspace, folders[i]);
			const baseCommit = await createWorktree({
				repo: source,
				branch: task.branch,
				worktreePath: copyPath,
				log: (text) => say(task.id, text),
				authEnv: await ctx.authEnvFor(repo)
			});
			await ctx.updateTask(task.id, { worktreePath: copyPath, baseCommit });
		}
		copies.push({
			folder: folders[i],
			path: copyPath,
			repository: repo,
			branch: task.branch,
			baseBranch: task.baseBranch
		});
	}
	if (signal.aborted) throw signal.reason;

	for (const task of run.tasks) {
		await ctx.updateTask(task.id, { status: 'running' });
		if (task.id !== lead.id)
			say(
				task.id,
				`Working on this together with the other repositories, in ${lead.repositoryName}'s activity.`
			);
	}
	if (followUp) say(lead.id, `Follow-up: ${followUp}`);
	const apiKey = await ctx.deps.getApiKey(input.model);
	if (signal.aborted) throw signal.reason;
	const before = await ctx.findTask(lead.id);
	const result = await ctx.deps.runAgent({
		cwd: workspace,
		instruction: followUp ? togetherFollowUpPrompt(run, before, followUp) : run.instruction,
		repository: repos[0],
		branch: lead.branch,
		baseBranch: lead.baseBranch,
		model: input.model,
		apiKey,
		signal,
		log: (entry) => ctx.log(lead.id, entry),
		requestApproval: (ask) => ctx.approvals.request(lead.id, ask, signal),
		workingCopies: copies
	});
	if (signal.aborted) throw signal.reason;
	// The cost and turns are the session's; they're kept on the first task.
	await ctx.updateTask(lead.id, {
		costUsd: followUp ? addUsage(before.costUsd, result.costUsd) : result.costUsd,
		turns: followUp ? addUsage(before.turns, result.turns) : result.turns
	});

	const { byFolder, all } = splitPullRequests(result.summary, folders);
	for (const [i, task] of run.tasks.entries()) {
		const text = all ?? byFolder.get(folders[i]);
		await ctx.updateTask(task.id, {
			summary: text?.body || null,
			title: text?.title ?? null
		});
	}

	for (const [i, task] of run.tasks.entries()) {
		const command = repos[i].checkCommand;
		if (command) {
			const checks = await performChecks(ctx, task.id, copies[i].path, command, signal);
			if (!checks) throw signal.reason ?? new Error('Checks stopped');
		}
		const current = await ctx.findTask(task.id);
		const { stat } = await collectDiff(copies[i].path, current.baseCommit!);
		say(
			task.id,
			stat.files === 0
				? 'Finished: no changes in this repository.'
				: `Finished: ${stat.files} ${stat.files === 1 ? 'file' : 'files'} changed, +${stat.insertions} −${stat.deletions}.`
		);
		await ctx.updateTask(task.id, {
			status: 'awaiting_review',
			finishedAt: new Date().toISOString(),
			diffStat: stat
		});
	}
}
