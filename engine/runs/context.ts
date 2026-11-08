import { tryGit } from '../git/git.js';
import {
	EngineError,
	type LogEntry,
	type Repository,
	type Run,
	type Task
} from '#lib/engine/contract.js';
import type { AgentRunner } from '../agent/runner.js';
import { createApprovals } from './approvals.js';
import type { EngineEvents } from '../core/events.js';
import type { TaskLogs } from '../core/logs.js';
import type { JsonStore } from '../core/store.js';
import { providerAuthEnv, providerFor, type ProviderSettings } from '../providers/index.js';

export interface RunServiceDeps {
	store: JsonStore;
	logs: TaskLogs;
	events: EngineEvents;
	runAgent: AgentRunner;
	worktreesDir: string;
	/** The API key for the agent that runs this model, if one is saved or set. */
	getApiKey: (model: string) => Promise<string | null>;
	/** Pull request providers (GitHub, GitLab) and their tokens. */
	providers: ProviderSettings;
	/** Clone a repository that was added by URL, if it isn't yet (shared between callers). */
	ensureCloned: (repositoryId: string) => Promise<Repository>;
	/** Add a repository by URL without cloning it (a review of a repository not added yet). */
	addRepositoryFromUrl: (url: string) => Promise<Repository>;
	/** How many tasks may run at the same time, at first; see `setConcurrency`. */
	concurrency: number;
	/** Save a program as always allowed outside the sandbox in a repository. */
	allowProgram: (repositoryId: string, program: string) => Promise<void>;
}

/** A queued task for one repository, with nothing done yet. */
export function newTask(input: {
	id: string;
	runId: string;
	repo: Repository;
	branch: string;
	baseBranch: string;
}): Task {
	return {
		id: input.id,
		runId: input.runId,
		repositoryId: input.repo.id,
		repositoryName: input.repo.name,
		status: 'queued',
		branch: input.branch,
		baseBranch: input.baseBranch,
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
		exploration: null,
		approval: null
	};
}

/** Adds up cost or turns across follow-ups; null only when neither is known. */
export const addUsage = (a: number | null, b: number | null) =>
	a === null && b === null ? null : (a ?? 0) + (b ?? 0);

/**
 * What every part of the run service shares: the store, task updates, repository access, and
 * the agents' requests to run commands outside the sandbox.
 */
export function createRunContext(deps: RunServiceDeps) {
	const base = createRunContextBase(deps);
	return { ...base, approvals: createApprovals(base) };
}

export function createRunContextBase(deps: RunServiceDeps) {
	const { store, logs, events } = deps;

	async function findTask(taskId: string): Promise<Task> {
		for (const run of (await store.read()).runs) {
			const task = run.tasks.find((t) => t.id === taskId);
			if (task) return task;
		}
		throw new EngineError('task_not_found', `Unknown task: ${taskId}`);
	}

	async function findRun(runId: string): Promise<Run | undefined> {
		return (await store.read()).runs.find((r) => r.id === runId);
	}

	async function findRepository(repositoryId: string): Promise<Repository | undefined> {
		return (await store.read()).repositories.find((r) => r.id === repositoryId);
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

	/** HTTPS credentials for a repository's provider, if a token is available (never throws). */
	async function authEnvFor(repo: Repository): Promise<Record<string, string>> {
		try {
			const provider = await providerFor(repo, deps.providers);
			return providerAuthEnv(repo.remoteUrl, provider?.kind ?? null, provider?.token ?? null);
		} catch {
			return {};
		}
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

	return {
		deps,
		store,
		findTask,
		findRun,
		findRepository,
		updateTask,
		log,
		authEnvFor,
		prepareSource,
		fetchCommit
	};
}

export type RunContext = ReturnType<typeof createRunContext>;
