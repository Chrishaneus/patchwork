import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
	EngineError,
	activeTaskStatuses,
	type EngineErrorData,
	type LogEntry,
	type PublishInput,
	type PullRequest,
	type Repository,
	type ReviewAttribute,
	type ReviewedPullRequest,
	type ReviewResult,
	type Run,
	type Task,
	type TaskChecks,
	type TaskDiff
} from '#lib/engine/contract.js';
import type { AgentRunner } from '../agent/runner.js';
import { runCheckCommand } from './checks.js';
import type { EngineEvents } from '../core/events.js';
import { git, tryGit } from '../git/git.js';
import {
	providerAuthEnv,
	providerFor,
	pullRequestRef,
	supportsPullRequests,
	type ProviderSettings
} from '../providers/index.js';
import {
	askFollowUpPrompt,
	askPrompt,
	explorePrompt,
	parseExploration,
	parseReview,
	readOnlyFollowUpPrompt,
	reviewMarkdown,
	reviewPrompt
} from './workflows.js';
import { commitChanges, pushBranch } from '../git/publish.js';
import type { TaskLogs } from '../core/logs.js';
import { readStatus } from '../repositories/index.js';
import type { JsonStore } from '../core/store.js';
import {
	assertValidBranchName,
	collectDiff,
	createWorktree,
	diffBetween,
	removeWorktree,
	removeWorktreeOnly,
	suggestBranchName
} from '../git/worktrees.js';

interface RunServiceDeps {
	store: JsonStore;
	logs: TaskLogs;
	events: EngineEvents;
	runAgent: AgentRunner;
	worktreesDir: string;
	getApiKey: () => Promise<string | null>;
	/** Pull request providers (GitHub, GitLab) and their tokens. */
	providers: ProviderSettings;
	/** Clone a repository that was added by URL, if it isn't yet (shared between callers). */
	ensureCloned: (repositoryId: string) => Promise<Repository>;
	/** How many tasks may run at the same time, at first; see `setConcurrency`. */
	concurrency: number;
}

type StopReason = 'cancelled' | 'timeout';

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

export function createRunService(deps: RunServiceDeps) {
	const { store, logs, events } = deps;
	const controllers = new Map<string, { controller: AbortController; reason?: StopReason }>();
	const queue: string[] = [];
	let running = 0;

	async function findTask(taskId: string): Promise<Task> {
		for (const run of (await store.read()).runs) {
			const task = run.tasks.find((t) => t.id === taskId);
			if (task) return task;
		}
		throw new EngineError('task_not_found', `Unknown task: ${taskId}`);
	}

	async function updateTask(taskId: string, change: Partial<Task>): Promise<Task> {
		const task = await store.update((data) => {
			for (const run of data.runs) {
				const index = run.tasks.findIndex((t) => t.id === taskId);
				if (index !== -1) {
					run.tasks[index] = { ...run.tasks[index], ...change };
					return run.tasks[index];
				}
			}
			throw new EngineError('task_not_found', `Unknown task: ${taskId}`);
		});
		events.emit({ type: 'task.updated', task });
		return task;
	}

	function log(taskId: string, entry: Omit<LogEntry, 'at'>) {
		const full: LogEntry = { at: new Date().toISOString(), ...entry };
		events.emit({ type: 'task.log', taskId, entry: full });
		logs.append(taskId, full).catch(() => undefined);
	}

	let concurrency = deps.concurrency;

	/** HTTPS credentials for a repository's provider, if a token is available (never throws). */
	async function authEnvFor(repo: Repository): Promise<Record<string, string>> {
		try {
			const provider = await providerFor(repo, deps.providers);
			return providerAuthEnv(repo.remoteUrl, provider?.kind ?? null, provider?.token ?? null);
		} catch {
			return {};
		}
	}
	/** Follow-up instructions waiting in the queue, by task id. */
	const pendingFollowUps = new Map<string, string>();

	/**
	 * Run the repository's check command in the worktree and record the result on the task.
	 * Resolves to null when the command was stopped (cancel or time limit).
	 */
	async function performChecks(
		taskId: string,
		worktreePath: string,
		command: string,
		signal: AbortSignal
	): Promise<TaskChecks | null> {
		const started: TaskChecks = {
			status: 'running',
			command,
			exitCode: null,
			output: '',
			startedAt: new Date().toISOString(),
			finishedAt: null
		};
		await updateTask(taskId, { status: 'checking', checks: started });
		log(taskId, { kind: 'tool', text: `$ ${command}` });
		const result = await runCheckCommand({ cwd: worktreePath, command, signal });
		const checks: TaskChecks = {
			...started,
			status: !result.stopped && result.exitCode === 0 ? 'passed' : 'failed',
			exitCode: result.exitCode,
			output: result.stopped ? `${result.output}\n(stopped)`.trim() : result.output,
			finishedAt: new Date().toISOString()
		};
		await updateTask(taskId, { checks });
		if (result.stopped) return null;
		log(taskId, {
			kind: checks.status === 'passed' ? 'info' : 'error',
			text:
				checks.status === 'passed'
					? 'Checks passed.'
					: `Checks failed (exit code ${result.exitCode ?? 'unknown'}).`
		});
		return checks;
	}

	function pump() {
		while (running < concurrency && queue.length > 0) {
			const taskId = queue.shift()!;
			running += 1;
			execute(taskId).finally(() => {
				running -= 1;
				pump();
			});
		}
	}

	/** Create a run with one task per repository and queue its tasks. */
	async function queueRun(input: {
		kind: 'review' | 'explore' | 'ask';
		instruction: string;
		repos: Repository[];
		pullRequest?: ReviewedPullRequest;
		attributes?: ReviewAttribute[];
		focus?: string;
		branch: (repo: Repository) => string;
		baseBranch: (repo: Repository) => string;
	}): Promise<Run> {
		const runId = randomUUID();
		const tasks: Task[] = input.repos.map((repo) => ({
			id: randomUUID(),
			runId,
			repositoryId: repo.id,
			repositoryName: repo.name,
			status: 'queued',
			branch: input.branch(repo),
			baseBranch: input.baseBranch(repo),
			baseCommit: null,
			worktreePath: null,
			startedAt: null,
			finishedAt: null,
			summary: null,
			error: null,
			costUsd: null,
			turns: null,
			diffStat: null,
			commitSha: null,
			pushedAt: null,
			pullRequest: null,
			publishError: null,
			checks: null,
			followUps: [],
			review: null,
			exploration: null
		}));
		const run: Run = {
			id: runId,
			kind: input.kind,
			instruction: input.instruction,
			createdAt: new Date().toISOString(),
			tasks,
			...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
			...(input.attributes ? { attributes: input.attributes } : {}),
			...(input.focus ? { focus: input.focus } : {})
		};
		await store.update((data) => {
			data.runs.unshift(run);
		});
		for (const task of tasks) {
			controllers.set(task.id, { controller: new AbortController() });
			queue.push(task.id);
		}
		pump();
		return run;
	}

	/** Repositories added by URL are cloned the first time something runs on them. */
	async function prepareSource(repo: Repository, say: (text: string) => void) {
		if (!repo.managed) return repo;
		const needsClone = (repo.cloneStatus ?? 'ready') !== 'ready';
		if (needsClone) say(`Cloning ${repo.remoteUrl}…`);
		const source = await deps.ensureCloned(repo.id);
		if (needsClone) say(`Cloned into ${source.path}.`);
		return source;
	}

	/** Fetch a ref from the repository's remote; returns the fetched commit, or null. */
	async function fetchCommit(repo: Repository, ref: string, env: Record<string, string>) {
		const fetched = await tryGit(repo.path, ['fetch', '--quiet', repo.remoteName, ref], {
			timeoutMs: 120_000,
			env
		});
		return fetched === null ? null : tryGit(repo.path, ['rev-parse', 'FETCH_HEAD^{commit}']);
	}

	/** Remove a read-only task's working copy, if it has one. */
	async function dropWorkingCopy(taskId: string) {
		const task = await findTask(taskId).catch(() => null);
		if (!task?.worktreePath) return;
		const repo = (await store.read()).repositories.find((r) => r.id === task.repositoryId);
		if (repo) await removeWorktreeOnly(repo, task.worktreePath);
		await updateTask(taskId, { worktreePath: null });
	}

	/**
	 * Review and explore: a detached working copy (no branch of its own), the agent in read-only
	 * mode, and its JSON answer parsed onto the task.
	 */
	async function executeReadOnly(
		taskId: string,
		run: Run,
		repo: Repository,
		signal: AbortSignal,
		model: string,
		say: (text: string) => void,
		followUp?: string
	) {
		const before = await findTask(taskId);
		if (followUp) say(`Follow-up: ${followUp}`);
		await updateTask(taskId, { status: 'preparing', startedAt: new Date().toISOString() });
		const source = await prepareSource(repo, say);
		if (signal.aborted) throw signal.reason;
		const env = await authEnvFor(repo);
		const worktreePath = path.join(deps.worktreesDir, taskId);

		let head: string;
		let baseCommit: string;
		if (run.kind === 'review') {
			const pr = run.pullRequest!;
			say(`Fetching pull request #${pr.number}…`);
			const base = await fetchCommit(source, pr.baseRef, env);
			// The PR's head from the base repository (works for forks too), else its branch.
			const fetchedHead =
				(await fetchCommit(source, pullRequestRef(pr.provider, pr.number), env)) ??
				(await fetchCommit(source, pr.headRef, env));
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
			const latest = await fetchCommit(source, repo.defaultBranch, env);
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
		await updateTask(taskId, { worktreePath, baseCommit });
		if (signal.aborted) throw signal.reason;

		await updateTask(taskId, { status: 'running' });
		const apiKey = await deps.getApiKey();
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
		const result = await deps.runAgent({
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
			model,
			apiKey,
			signal,
			log: (entry) => log(taskId, entry),
			mode: run.kind,
			attributes: run.attributes
		});
		if (signal.aborted) throw signal.reason;
		const add = (a: number | null, b: number | null) =>
			a === null && b === null ? null : (a ?? 0) + (b ?? 0);
		await updateTask(taskId, {
			costUsd: followUp ? add(before.costUsd, result.costUsd) : result.costUsd,
			turns: followUp ? add(before.turns, result.turns) : result.turns
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
		await dropWorkingCopy(taskId);

		if (run.kind === 'ask') {
			await updateTask(taskId, {
				status: 'completed',
				finishedAt: new Date().toISOString(),
				summary: result.summary
			});
		} else if (review) {
			say(
				`Review finished: ${review.scores.map((s) => `${s.attribute} ${s.score}/5`).join(', ')}.`
			);
			await updateTask(taskId, {
				status: 'completed',
				finishedAt: new Date().toISOString(),
				review,
				summary: review.summary
			});
		} else if (exploration) {
			say(`Exploration finished: ${exploration.approaches.length} approaches.`);
			await updateTask(taskId, {
				status: 'completed',
				finishedAt: new Date().toISOString(),
				exploration,
				summary: exploration.recommendation
			});
		}
	}

	async function execute(taskId: string) {
		const handle = controllers.get(taskId);
		if (!handle || handle.controller.signal.aborted) return;
		const { signal } = handle.controller;
		const { settings, repositories } = await store.read();
		const task = await findTask(taskId);
		const repo = repositories.find((r) => r.id === task.repositoryId);
		const say = (text: string) => log(taskId, { kind: 'info', text });
		const followUp = pendingFollowUps.get(taskId);
		pendingFollowUps.delete(taskId);

		const timer = setTimeout(() => {
			handle.reason = 'timeout';
			handle.controller.abort();
		}, settings.timeoutMinutes * 60_000);

		const run = (await store.read()).runs.find((r) => r.id === task.runId)!;
		const kind = run.kind ?? 'code';
		try {
			if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
			if (kind !== 'code') {
				await executeReadOnly(taskId, run, repo, signal, settings.model, say, followUp);
				return;
			}
			let worktreePath: string;
			let baseCommit: string;
			if (followUp && task.worktreePath && task.baseCommit) {
				// A follow-up continues in the same working copy.
				({ worktreePath, baseCommit } = task);
				say(`Follow-up: ${followUp}`);
			} else {
				await updateTask(taskId, { status: 'preparing', startedAt: new Date().toISOString() });
				// Repositories added by URL are cloned the first time a change runs on them.
				const source = await prepareSource(repo, say);
				if (signal.aborted) throw signal.reason;
				worktreePath = path.join(deps.worktreesDir, taskId);
				baseCommit = await createWorktree({
					repo: source,
					branch: task.branch,
					worktreePath,
					log: say,
					authEnv: await authEnvFor(repo)
				});
				await updateTask(taskId, { worktreePath, baseCommit });
			}
			if (signal.aborted) throw signal.reason;

			await updateTask(taskId, { status: 'running' });
			const apiKey = await deps.getApiKey();
			// A cancel can land while we were getting ready; don't start the agent then.
			if (signal.aborted) throw signal.reason;
			const result = await deps.runAgent({
				cwd: worktreePath,
				instruction: followUp
					? followUpPrompt(run.instruction, await findTask(taskId), followUp)
					: run.instruction,
				repository: repo,
				branch: task.branch,
				baseBranch: task.baseBranch,
				model: settings.model,
				apiKey,
				signal,
				log: (entry) => log(taskId, entry)
			});
			if (signal.aborted) throw signal.reason;
			const before = await findTask(taskId);
			const add = (a: number | null, b: number | null) =>
				a === null && b === null ? null : (a ?? 0) + (b ?? 0);
			await updateTask(taskId, {
				summary: result.summary,
				// Follow-ups add to the cost and turns of the earlier work.
				costUsd: followUp ? add(before.costUsd, result.costUsd) : result.costUsd,
				turns: followUp ? add(before.turns, result.turns) : result.turns
			});

			const command = (await store.read()).repositories.find((r) => r.id === repo.id)?.checkCommand;
			if (command) {
				const checks = await performChecks(taskId, worktreePath, command, signal);
				if (!checks) throw signal.reason ?? new Error('Checks stopped');
			}

			const { stat } = await collectDiff(worktreePath, baseCommit);
			say(
				`Finished: ${stat.files} ${stat.files === 1 ? 'file' : 'files'} changed, +${stat.insertions} −${stat.deletions}.`
			);
			await updateTask(taskId, {
				status: 'awaiting_review',
				finishedAt: new Date().toISOString(),
				diffStat: stat
			});
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
			if (kind !== 'code') await dropWorkingCopy(taskId);
			await updateTask(taskId, {
				status: reason === 'cancelled' ? 'cancelled' : 'failed',
				finishedAt: new Date().toISOString(),
				error: failure,
				diffStat
			});
		} finally {
			clearTimeout(timer);
			controllers.delete(taskId);
		}
	}

	return {
		/** Tasks that were working when the app last quit can't resume; mark them interrupted. */
		async recoverInterrupted() {
			const { runs } = await store.read();
			const anyActive = runs.some((run) =>
				run.tasks.some((t) => activeTaskStatuses.includes(t.status))
			);
			if (!anyActive) return;
			const interrupted: Task[] = [];
			await store.update((data) => {
				for (const run of data.runs) {
					run.tasks = run.tasks.map((task) => {
						if (!activeTaskStatuses.includes(task.status)) return task;
						if (task.status === 'checking' && task.finishedAt) {
							// Checks were re-run on a reviewed change: back to review.
							const back: Task = {
								...task,
								status: 'awaiting_review',
								checks: task.checks && {
									...task.checks,
									status: 'failed',
									output: `${task.checks.output}\n(interrupted)`.trim()
								}
							};
							interrupted.push(back);
							return back;
						}
						if (task.status === 'publishing') {
							const back: Task = {
								...task,
								status: 'awaiting_review',
								publishError: {
									code: 'interrupted',
									message: 'The app closed while publishing. Publish again to finish.'
								}
							};
							interrupted.push(back);
							return back;
						}
						const updated: Task = {
							...task,
							status: 'failed',
							finishedAt: new Date().toISOString(),
							error: { code: 'interrupted', message: 'The app closed while this task was running.' }
						};
						interrupted.push(updated);
						return updated;
					});
				}
			});
			for (const task of interrupted) events.emit({ type: 'task.updated', task });
		},

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
				tasks.push({
					id: taskId,
					runId,
					repositoryId: repo.id,
					repositoryName: repo.name,
					status: 'queued',
					branch,
					baseBranch: repo.defaultBranch,
					baseCommit: null,
					worktreePath: null,
					startedAt: null,
					finishedAt: null,
					summary: null,
					error: null,
					costUsd: null,
					turns: null,
					diffStat: null,
					commitSha: null,
					pushedAt: null,
					pullRequest: null,
					publishError: null,
					checks: null,
					followUps: [],
					review: null,
					exploration: null
				});
			}

			const run: Run = {
				id: runId,
				kind: 'code',
				instruction,
				createdAt: new Date().toISOString(),
				tasks
			};
			await store.update((data) => {
				data.runs.unshift(run);
			});
			for (const task of tasks) {
				controllers.set(task.id, { controller: new AbortController() });
				queue.push(task.id);
			}
			pump();
			return run;
		},

		async list(): Promise<Run[]> {
			return (await store.read()).runs;
		},

		async get(id: string): Promise<Run> {
			const run = (await store.read()).runs.find((r) => r.id === id);
			if (!run) throw new EngineError('run_not_found', `Unknown run: ${id}`);
			return run;
		},

		async log(taskId: string): Promise<LogEntry[]> {
			await findTask(taskId);
			return logs.read(taskId);
		},

		async diff(taskId: string): Promise<TaskDiff> {
			const task = await findTask(taskId);
			if (task.status === 'published' && task.baseCommit && task.commitSha) {
				const repo = (await store.read()).repositories.find((r) => r.id === task.repositoryId);
				if (repo) return diffBetween(repo.path, task.baseCommit, task.commitSha);
			}
			if (!task.worktreePath || !task.baseCommit || task.status === 'discarded') {
				return { stat: { files: 0, insertions: 0, deletions: 0 }, patch: '', truncated: false };
			}
			return collectDiff(task.worktreePath, task.baseCommit);
		},

		async cancel(taskId: string): Promise<Task> {
			const task = await findTask(taskId);
			const handle = controllers.get(taskId);
			if (!handle || !activeTaskStatuses.includes(task.status)) {
				throw new EngineError('invalid_state', 'Only queued or running tasks can be cancelled.');
			}
			handle.reason = 'cancelled';
			handle.controller.abort(new EngineError('interrupted', 'Cancelled'));
			if (task.status === 'queued') {
				queue.splice(queue.indexOf(taskId), 1);
				controllers.delete(taskId);
				log(taskId, { kind: 'error', text: 'Cancelled.' });
				return updateTask(taskId, { status: 'cancelled', finishedAt: new Date().toISOString() });
			}
			return task;
		},

		/**
		 * Commit, push and open the pull request. Failures leave the task in review with
		 * `publishError` set, so publishing can simply be retried.
		 */
		async publish(input: PublishInput): Promise<Task> {
			const title = input.title?.trim();
			const body = (input.body ?? '').trim();
			if (!title) throw new EngineError('invalid_input', 'The pull request needs a title.');
			const task = await findTask(input.taskId);
			if (task.status !== 'awaiting_review' || !task.worktreePath || !task.baseCommit) {
				throw new EngineError(
					'invalid_state',
					'Only changes that are ready for review can be published.'
				);
			}
			const repo = (await store.read()).repositories.find((r) => r.id === task.repositoryId);
			if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');

			// Resolve the provider first: a missing token stops publishing before git is touched.
			const provider = await providerFor(repo, deps.providers);

			const { worktreePath, baseCommit } = task;
			const say = (text: string) => log(task.id, { kind: 'info', text });
			await updateTask(task.id, { status: 'publishing', publishError: null });
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
				await updateTask(task.id, { commitSha, pushedAt });

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
				return await updateTask(task.id, { status: 'published', pullRequest, worktreePath: null });
			} catch (error) {
				const publishError: EngineErrorData =
					error instanceof EngineError
						? { code: error.code, message: error.message }
						: { code: 'internal', message: error instanceof Error ? error.message : String(error) };
				log(task.id, { kind: 'error', text: publishError.message });
				return updateTask(task.id, { status: 'awaiting_review', publishError });
			}
		},

		/** Queue more work on a task that has a working copy. */
		async followUp(taskId: string, instruction: string): Promise<Task> {
			const text = instruction?.trim();
			if (!text) throw new EngineError('invalid_input', 'Describe what else should change.');
			const task = await findTask(taskId);
			const kind = (await store.read()).runs.find((r) => r.id === task.runId)?.kind ?? 'code';
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
			const repo = (await store.read()).repositories.find((r) => r.id === task.repositoryId);
			if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');

			const queued = await updateTask(taskId, {
				status: 'queued',
				error: null,
				publishError: null,
				finishedAt: null,
				followUps: [...(task.followUps ?? []), { instruction: text, at: new Date().toISOString() }]
			});
			controllers.set(taskId, { controller: new AbortController() });
			pendingFollowUps.set(taskId, text);
			queue.push(taskId);
			pump();
			return queued;
		},

		/** Refresh the state of open pull requests from their providers. */
		async syncPullRequests(): Promise<{ updated: number }> {
			const { runs, repositories } = await store.read();
			let updated = 0;
			for (const task of runs.flatMap((r) => r.tasks)) {
				const pr = task.pullRequest;
				if (!pr || (pr.state ?? 'open') !== 'open') continue;
				const repo = repositories.find((r) => r.id === task.repositoryId);
				if (!repo || !supportsPullRequests(repo)) continue;
				try {
					const provider = await providerFor(repo, deps.providers);
					if (!provider) continue;
					const state = await provider.getState(repo.slug!, pr.number);
					const syncedAt = new Date().toISOString();
					await updateTask(task.id, {
						pullRequest: { ...pr, provider: pr.provider ?? provider.kind, state, syncedAt }
					});
					if (state !== 'open') {
						updated += 1;
						log(task.id, { kind: 'info', text: `Pull request ${state}.` });
					}
				} catch {
					// No token or the provider is unreachable: try again on the next sync.
				}
			}
			return { updated };
		},

		/** Change how many tasks run at once; queued tasks start right away if there's room. */
		/** Queue a review of one pull request. */
		startReview(input: {
			repo: Repository;
			pullRequest: ReviewedPullRequest;
			attributes: ReviewAttribute[];
			instruction?: string;
			focus?: string;
		}): Promise<Run> {
			return queueRun({
				kind: 'review',
				instruction: input.instruction || input.pullRequest.title,
				focus: input.focus,
				repos: [input.repo],
				pullRequest: input.pullRequest,
				attributes: input.attributes,
				branch: () => input.pullRequest.headRef,
				baseBranch: () => input.pullRequest.baseRef
			});
		},

		/** Queue an exploration of an idea in one or more repositories. */
		startExplore(input: {
			repos: Repository[];
			idea: string;
			kind?: 'explore' | 'ask';
		}): Promise<Run> {
			return queueRun({
				kind: input.kind ?? 'explore',
				instruction: input.idea,
				repos: input.repos,
				branch: () => '',
				baseBranch: (repo) => repo.defaultBranch
			});
		},

		/** Post a finished review on its pull request, as a comment. */
		async postReview(taskId: string): Promise<Task> {
			const task = await findTask(taskId);
			const { runs, repositories } = await store.read();
			const run = runs.find((r) => r.id === task.runId);
			if (!task.review || !run?.pullRequest) {
				throw new EngineError('invalid_state', 'Only finished reviews can be posted.');
			}
			if (task.review.postedUrl) return task;
			const repo = repositories.find((r) => r.id === task.repositoryId);
			if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
			const provider = await providerFor(repo, deps.providers);
			if (!provider || !repo.slug) {
				throw new EngineError('invalid_state', 'This repository is not on GitHub or GitLab.');
			}
			const postedUrl = await provider.comment(
				repo.slug,
				run.pullRequest.number,
				reviewMarkdown(task.review)
			);
			log(taskId, { kind: 'info', text: `Posted the review: ${postedUrl}` });
			return updateTask(taskId, { review: { ...task.review, postedUrl } });
		},

		setConcurrency(value: number) {
			concurrency = value;
			pump();
		},

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
			const handle: { controller: AbortController; reason?: StopReason } = {
				controller: new AbortController()
			};
			controllers.set(taskId, handle);
			const timer = setTimeout(() => {
				handle.reason = 'timeout';
				handle.controller.abort();
			}, settings.timeoutMinutes * 60_000);
			try {
				await performChecks(taskId, task.worktreePath, command, handle.controller.signal);
				if (handle.reason)
					log(taskId, {
						kind: 'error',
						text: handle.reason === 'timeout' ? 'Checks ran out of time.' : 'Checks stopped.'
					});
			} finally {
				clearTimeout(timer);
				controllers.delete(taskId);
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
			const { repositories, runs } = await store.read();
			const repo = repositories.find((r) => r.id === task.repositoryId);
			const kind = runs.find((r) => r.id === task.runId)?.kind ?? 'code';
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
