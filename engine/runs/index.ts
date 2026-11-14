import { randomUUID } from 'node:crypto';
import {
	EngineError,
	activeTaskStatuses,
	type EngineErrorData,
	type LogEntry,
	type PublishInput,
	type PullRequestToReview,
	type Repository,
	type ReviewAttribute,
	type ReviewedPullRequest,
	type Run,
	type Task,
	type TaskDiff
} from '#lib/engine/contract.js';
import {
	assertValidBranchName,
	collectDiff,
	diffBetween,
	removeWorktree,
	removeWorktreeOnly,
	suggestBranchName
} from '../git/worktrees.js';
import { readStatus } from '../repositories/index.js';
import { performChecks } from './checks.js';
import { executeCodeTask, switchPrompt } from './code-task.js';
import { createRunContext, newTask, type RunServiceDeps } from './context.js';
import { publishTask, postReview, syncPullRequests } from './publishing.js';
import { findPullRequestsToReview, listPullRequests } from './pull-requests.js';
import { createTaskQueue, startTimeLimit, type TaskHandle } from './queue.js';
import { dropWorkingCopy, executeReadOnlyTask } from './read-only-task.js';
import { recoverInterrupted } from './recovery.js';
import { cleanAttributes, reviewFocus } from './workflows.js';

export type { RunServiceDeps } from './context.js';

export function createRunService(deps: RunServiceDeps) {
	const ctx = createRunContext(deps);
	const { store, findTask, updateTask, log } = ctx;
	/** Follow-up instructions waiting in the queue, by task id. */
	const pendingFollowUps = new Map<string, string>();
	/** Prompts for tasks whose question or exploration just became a change, by task id. */
	const pendingSwitches = new Map<string, string>();
	const queue = createTaskQueue(execute, deps.concurrency);

	/** Run one task: the right workflow within the time limit, recording how it ended. */
	async function execute(taskId: string, handle: TaskHandle) {
		const { signal } = handle.controller;
		const { settings, repositories } = await store.read();
		const task = await findTask(taskId);
		const repo = repositories.find((r) => r.id === task.repositoryId);
		const say = (text: string) => log(taskId, { kind: 'info', text });
		const followUp = pendingFollowUps.get(taskId);
		pendingFollowUps.delete(taskId);
		const switched = pendingSwitches.get(taskId);
		pendingSwitches.delete(taskId);

		const clearTimeLimit = startTimeLimit(handle, settings.timeoutMinutes);
		const run = (await ctx.findRun(task.runId))!;
		const kind = run.kind ?? 'code';
		try {
			if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
			const input = { taskId, task, run, repo, signal, model: settings.model, say, followUp };
			if (kind === 'code') await executeCodeTask(ctx, { ...input, switched });
			else await executeReadOnlyTask(ctx, input);
		} catch (error) {
			const reason = handle.reason;
			const latest = await findTask(taskId);
			const diffStat =
				kind === 'code' && latest.worktreePath && latest.baseCommit
					? ((await collectDiff(latest.worktreePath, latest.baseCommit).catch(() => null))?.stat ??
						null)
					: null;
			const failure: EngineErrorData | null =
				reason === 'cancelled'
					? null
					: reason === 'timeout'
						? { code: 'timeout', message: `Stopped after ${settings.timeoutMinutes} minutes.` }
						: error instanceof EngineError
							? { code: error.code, message: error.message }
							: {
									code: 'agent_failed',
									message: error instanceof Error ? error.message : String(error)
								};
			log(taskId, { kind: 'error', text: failure ? failure.message : 'Cancelled.' });
			if (kind !== 'code') await dropWorkingCopy(ctx, taskId);
			await updateTask(taskId, {
				status: reason === 'cancelled' ? 'cancelled' : 'failed',
				finishedAt: new Date().toISOString(),
				error: failure,
				diffStat
			});
		} finally {
			clearTimeLimit();
		}
	}

	/** Save a new run and queue its tasks. */
	async function queueRun(run: Run): Promise<Run> {
		await store.update((data) => {
			data.runs.unshift(run);
		});
		queue.enqueue(run.tasks.map((t) => t.id));
		return run;
	}

	/** A read-only run (review, explore or ask) with one task per repository. */
	function queueReadOnlyRun(input: {
		kind: 'review' | 'explore' | 'ask';
		instruction: string;
		repos: Repository[];
		pullRequest?: ReviewedPullRequest;
		pullRequests?: ReviewedPullRequest[];
		attributes?: ReviewAttribute[];
		focus?: string;
		branch: (repo: Repository) => string;
		baseBranch: (repo: Repository) => string;
	}): Promise<Run> {
		const runId = randomUUID();
		return queueRun({
			id: runId,
			kind: input.kind,
			instruction: input.instruction,
			createdAt: new Date().toISOString(),
			tasks: input.repos.map((repo) =>
				newTask({
					id: randomUUID(),
					runId,
					repo,
					branch: input.branch(repo),
					baseBranch: input.baseBranch(repo)
				})
			),
			...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
			...(input.pullRequests ? { pullRequests: input.pullRequests } : {}),
			...(input.attributes ? { attributes: input.attributes } : {}),
			...(input.focus ? { focus: input.focus } : {})
		});
	}

	return {
		recoverInterrupted: () => recoverInterrupted(store, deps.events),

		async start(input: {
			repositoryIds: string[];
			instruction: string;
			branch?: string;
		}): Promise<Run> {
			const instruction = input.instruction?.trim();
			const ids = [...new Set(input.repositoryIds ?? [])];
			if (!instruction) throw new EngineError('invalid_input', 'Describe the change first.');
			if (ids.length === 0)
				throw new EngineError('invalid_input', 'Choose at least one repository.');
			const branchOverride = input.branch?.trim() || undefined;
			if (branchOverride && ids.length > 1) {
				throw new EngineError(
					'invalid_input',
					'A custom branch name works with one repository only.'
				);
			}

			const { repositories } = await store.read();
			const runId = randomUUID();
			const tasks: Task[] = [];
			for (const id of ids) {
				const repo = repositories.find((r) => r.id === id);
				if (!repo) throw new EngineError('repository_not_found', `Unknown repository: ${id}`);
				// Repositories added by URL may not be cloned yet; that happens when the task starts.
				const notClonedYet = repo.managed && (repo.cloneStatus ?? 'ready') !== 'ready';
				if (!notClonedYet && !(await readStatus(repo.path)).available) {
					throw new EngineError('repository_unavailable', `The folder is missing: ${repo.path}`);
				}
				const taskId = randomUUID();
				const branch = branchOverride ?? suggestBranchName(instruction, taskId.slice(0, 6));
				await assertValidBranchName(repo.path, branch);
				tasks.push(newTask({ id: taskId, runId, repo, branch, baseBranch: repo.defaultBranch }));
			}

			return queueRun({
				id: runId,
				kind: 'code',
				instruction,
				createdAt: new Date().toISOString(),
				tasks
			});
		},

		async list(): Promise<Run[]> {
			return (await store.read()).runs;
		},

		async get(id: string): Promise<Run> {
			const run = await ctx.findRun(id);
			if (!run) throw new EngineError('run_not_found', `Unknown run: ${id}`);
			return run;
		},

		async log(taskId: string): Promise<LogEntry[]> {
			await findTask(taskId);
			return deps.logs.read(taskId);
		},

		async diff(taskId: string): Promise<TaskDiff> {
			const task = await findTask(taskId);
			if (task.status === 'published' && task.baseCommit && task.commitSha) {
				const repo = await ctx.findRepository(task.repositoryId);
				if (repo) return diffBetween(repo.path, task.baseCommit, task.commitSha);
			}
			if (!task.worktreePath || !task.baseCommit || task.status === 'discarded') {
				return { stat: { files: 0, insertions: 0, deletions: 0 }, patch: '', truncated: false };
			}
			return collectDiff(task.worktreePath, task.baseCommit);
		},

		async cancel(taskId: string): Promise<Task> {
			const task = await findTask(taskId);
			const handle = queue.handle(taskId);
			if (!handle || !activeTaskStatuses.includes(task.status)) {
				throw new EngineError('invalid_state', 'Only queued or running tasks can be cancelled.');
			}
			handle.reason = 'cancelled';
			handle.controller.abort(new EngineError('interrupted', 'Cancelled'));
			if (task.status === 'queued') {
				queue.remove(taskId);
				log(taskId, { kind: 'error', text: 'Cancelled.' });
				return updateTask(taskId, { status: 'cancelled', finishedAt: new Date().toISOString() });
			}
			return task;
		},

		publish: (input: PublishInput) => publishTask(ctx, input),

		answerApproval: ctx.approvals.answer,

		/** Queue more work on a task that has a working copy. */
		async followUp(taskId: string, instruction: string): Promise<Task> {
			const text = instruction?.trim();
			if (!text) throw new EngineError('invalid_input', 'Describe what else should change.');
			const task = await findTask(taskId);
			const kind = (await ctx.findRun(task.runId))?.kind ?? 'code';
			// Reviews and explorations start a fresh read-only copy for each question.
			const readOnly =
				kind !== 'code' && ['completed', 'failed', 'cancelled'].includes(task.status);
			const allowed: Task['status'][] = ['awaiting_review', 'failed', 'cancelled'];
			if (
				!readOnly &&
				(kind !== 'code' ||
					!allowed.includes(task.status) ||
					!task.worktreePath ||
					!task.baseCommit)
			) {
				throw new EngineError(
					'invalid_state',
					'Follow-ups need a change in review (or a failed or cancelled one with its working copy).'
				);
			}
			if (!(await ctx.findRepository(task.repositoryId))) {
				throw new EngineError('repository_not_found', 'The repository was removed.');
			}

			const queued = await updateTask(taskId, {
				status: 'queued',
				error: null,
				publishError: null,
				finishedAt: null,
				followUps: [...(task.followUps ?? []), { instruction: text, at: new Date().toISOString() }]
			});
			pendingFollowUps.set(taskId, text);
			queue.enqueue([taskId]);
			return queued;
		},

		/** Turn a finished question or exploration into a change, keeping the conversation. */
		async switchToChange(runId: string, instruction: string): Promise<Run> {
			const text = instruction?.trim();
			if (!text) throw new EngineError('invalid_input', 'Describe the change first.');
			const run = await ctx.findRun(runId);
			if (!run) throw new EngineError('run_not_found', `Unknown run: ${runId}`);
			const from = run.kind;
			if (from !== 'ask' && from !== 'explore') {
				throw new EngineError(
					'invalid_state',
					'Only questions and explorations can become a change.'
				);
			}
			if (run.tasks.some((t) => activeTaskStatuses.includes(t.status))) {
				throw new EngineError('invalid_state', 'Wait for the agent to finish first.');
			}
			const done = run.tasks.filter((t) => ['completed', 'failed', 'cancelled'].includes(t.status));
			if (done.length === 0) throw new EngineError('invalid_state', 'Nothing here to change.');

			const { repositories } = await store.read();
			const branches = new Map<string, string>();
			const prompts = new Map<string, string>();
			for (const task of done) {
				const repo = repositories.find((r) => r.id === task.repositoryId);
				if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
				const branch = suggestBranchName(text, task.id.slice(0, 6));
				await assertValidBranchName(repo.path, branch);
				branches.set(task.id, branch);
				prompts.set(task.id, switchPrompt(run, task, text));
			}

			const at = new Date().toISOString();
			const switched = await store.update((data) => {
				const target = data.runs.find((r) => r.id === runId);
				if (
					target?.kind !== from ||
					target.tasks.some((t) => activeTaskStatuses.includes(t.status))
				) {
					throw new EngineError('invalid_state', 'Wait for the agent to finish first.');
				}
				target.kind = 'code';
				target.switchedFrom = { kind: from, at };
				target.tasks = target.tasks.map((task) =>
					branches.has(task.id)
						? {
								...task,
								status: 'queued',
								branch: branches.get(task.id)!,
								baseCommit: null,
								worktreePath: null,
								finishedAt: null,
								error: null,
								diffStat: null,
								followUps: [...(task.followUps ?? []), { instruction: text, at }]
							}
						: task
				);
				return target;
			});
			for (const [id, prompt] of prompts) pendingSwitches.set(id, prompt);
			deps.events.emit({ type: 'run.updated', run: switched });
			for (const task of switched.tasks) {
				if (branches.has(task.id)) deps.events.emit({ type: 'task.updated', task });
			}
			queue.enqueue([...branches.keys()]);
			return switched;
		},

		syncPullRequests: () => syncPullRequests(ctx),

		listPullRequests: (repositoryId: string) => listPullRequests(ctx, repositoryId),

		/** Queue a review of one pull request, by link or by repository and number. */
		async startReview(input: {
			url?: string;
			repositoryId?: string;
			number?: number;
			pullRequests?: PullRequestToReview[];
			attributes: ReviewAttribute[];
			instruction?: string;
		}): Promise<Run> {
			const attributes = cleanAttributes(input.attributes);
			const found = await findPullRequestsToReview(
				ctx,
				input.pullRequests?.length ? input.pullRequests : [input]
			);
			const [{ repo, pullRequest }] = found;
			const several = found.length > 1;
			return queueReadOnlyRun({
				kind: 'review',
				instruction:
					input.instruction?.trim() ||
					(several
						? found.map((f) => `#${f.pullRequest.number} ${f.pullRequest.title}`).join(', ')
						: pullRequest.title),
				// Whatever you wrote besides the links is for the agent.
				focus: reviewFocus(input.instruction),
				// One task, in the first pull request's repository, even when they span several.
				repos: [repo],
				pullRequest,
				...(several ? { pullRequests: found.map((f) => f.pullRequest) } : {}),
				attributes,
				branch: () => pullRequest.headRef,
				baseBranch: () => pullRequest.baseRef
			});
		},

		/** Queue an exploration of an idea, or a question, in one or more repositories. */
		async startReadOnly(input: {
			kind: 'explore' | 'ask';
			repositoryIds: string[];
			text: string;
		}): Promise<Run> {
			const { kind, repositoryIds, text } = input;
			if (typeof text !== 'string' || !text.trim()) {
				throw new EngineError(
					'invalid_input',
					kind === 'ask' ? 'Ask a question.' : 'Describe what you want to build.'
				);
			}
			if (!Array.isArray(repositoryIds) || repositoryIds.length === 0) {
				throw new EngineError('invalid_input', 'Choose at least one repository.');
			}
			const { repositories: known } = await store.read();
			const repos = repositoryIds.map((id) => {
				const repo = known.find((r) => r.id === id);
				if (!repo) throw new EngineError('repository_not_found', `Unknown repository: ${id}`);
				return repo;
			});
			return queueReadOnlyRun({
				kind,
				instruction: text.trim(),
				repos,
				branch: () => '',
				baseBranch: (repo) => repo.defaultBranch
			});
		},

		postReview: (taskId: string, url?: string) => postReview(ctx, taskId, url),

		/** Change how many tasks run at once; queued tasks start right away if there's room. */
		setConcurrency: (value: number) => queue.setConcurrency(value),

		/** Run the repository's check command again on a task in review. */
		async runChecks(taskId: string): Promise<Task> {
			const task = await findTask(taskId);
			if (task.status !== 'awaiting_review' || !task.worktreePath) {
				throw new EngineError(
					'invalid_state',
					'Checks can only run on changes that are in review.'
				);
			}
			const { repositories, settings } = await store.read();
			const command = repositories.find((r) => r.id === task.repositoryId)?.checkCommand;
			if (!command) {
				throw new EngineError('invalid_state', 'This repository has no check command.');
			}
			const handle = queue.register(taskId);
			const clearTimeLimit = startTimeLimit(handle, settings.timeoutMinutes);
			try {
				await performChecks(ctx, taskId, task.worktreePath, command, handle.controller.signal);
				if (handle.reason)
					log(taskId, {
						kind: 'error',
						text: handle.reason === 'timeout' ? 'Checks ran out of time.' : 'Checks stopped.'
					});
			} finally {
				clearTimeLimit();
				queue.release(taskId, handle);
			}
			return updateTask(taskId, { status: 'awaiting_review' });
		},

		async discard(taskId: string): Promise<Task> {
			const task = await findTask(taskId);
			if (activeTaskStatuses.includes(task.status)) {
				throw new EngineError('invalid_state', 'Cancel the task before discarding it.');
			}
			if (task.status === 'discarded') return task;
			if (task.status === 'published') {
				throw new EngineError(
					'invalid_state',
					'A published change can’t be discarded; close its pull request instead.'
				);
			}
			const repo = await ctx.findRepository(task.repositoryId);
			const kind = (await ctx.findRun(task.runId))?.kind ?? 'code';
			if (task.worktreePath && repo) {
				// Reviews and explorations never made a branch of their own.
				if (kind === 'code') await removeWorktree(repo, task.worktreePath, task.branch);
				else await removeWorktreeOnly(repo, task.worktreePath);
			}
			log(taskId, { kind: 'info', text: 'Discarded the worktree and branch.' });
			return updateTask(taskId, { status: 'discarded', worktreePath: null });
		}
	};
}
