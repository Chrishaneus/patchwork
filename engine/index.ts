import path from 'node:path';
import {
	EngineError,
	engineMethods,
	type EngineApi,
	type EngineErrorData,
	type EngineEvent,
	type EngineResult
} from '#lib/engine/contract.js';
import {
	createClaudeModeClassifier,
	createMessageClassifier,
	type ModeClassifier
} from './agent/classifier.js';
import { createClaudeAgentRunner, type AgentRunner } from './agent/runner.js';
import { EngineEvents } from './core/events.js';
import { TaskLogs } from './core/logs.js';
import { MemorySecretStore, type SecretStore } from './core/secrets.js';
import { JsonStore } from './core/store.js';
import { parseRemoteUrl } from './git/git.js';
import { createGitHubAuth } from './providers/github-auth.js';
import { providerAuthEnv } from './providers/index.js';
import { createRepositoryService } from './repositories/index.js';
import { createRunService } from './runs/index.js';
import { createCredentials } from './settings/credentials.js';
import { createSettingsService } from './settings/index.js';
import { createTemplateService } from './settings/templates.js';

export type { AgentRunner } from './agent/runner.js';
export { classifyByRules, type ModeClassifier } from './agent/classifier.js';
export { FileSecretStore, type SecretStore } from './core/secrets.js';
export { createTestAgent } from './agent/test-agent.js';

export interface EngineOptions {
	/** Folder for the engine's own data: the store, task logs and worktrees. */
	dataDir: string;
	/** Where the API key is kept. Defaults to memory only. */
	secrets?: SecretStore;
	/** The AI agent. Defaults to the Claude Agent SDK. */
	runAgent?: AgentRunner;
	/** Picks the workflow for Auto mode. Defaults to a small Claude model. */
	classifyMode?: ModeClassifier;
	/** Path to the Claude Code binary, when the host must point at it (packaged Electron). */
	agentExecutable?: string;
	/** Server mode: folders repositories must live in (e.g. the mounted /repos). */
	repositoryRoots?: string[];
	/** Whether local folders may be added (desktop: true; server: only with repositoryRoots). */
	localPaths?: boolean;
	/** github.com for sign-in (default https://github.com); a test server otherwise. */
	githubWebUrl?: string;
	/** GitHub App client ID from the environment (PATCHWORK_GITHUB_CLIENT_ID); Settings can set one too. */
	githubClientId?: string;
	/** GitHub's API (default https://api.github.com); a GitHub Enterprise or test server otherwise. */
	githubApiUrl?: string;
	/** GitLab's API, when it isn't https://<remote host>/api/v4 (self-hosted setups, tests). */
	gitlabApiUrl?: string;
	/** How often to refresh open pull requests' state; 0 turns the background sync off. */
	pullRequestSyncMs?: number;
}

export interface Engine extends EngineApi {
	/** Receive task updates and log lines; returns an unsubscribe function. */
	subscribe(listener: (event: EngineEvent) => void): () => void;
}

/** Create the engine. Hosts (Electron main, the HTTP server) wrap it with `handleEngineCall`. */
export function createEngine(options: EngineOptions): Engine {
	const store = new JsonStore(options.dataDir);
	const secrets = options.secrets ?? new MemorySecretStore();
	const events = new EngineEvents();
	const githubAuth = createGitHubAuth({
		webUrl: options.githubWebUrl ?? 'https://github.com',
		apiUrl: options.githubApiUrl ?? 'https://api.github.com',
		getClientId: async () =>
			(await store.read()).settings.githubClientId || options.githubClientId || null,
		secrets,
		events
	});
	const credentials = createCredentials(secrets, { signedInGitHubToken: () => githubAuth.token() });

	const repositories = createRepositoryService(store, {
		roots: options.repositoryRoots,
		localPaths: options.localPaths ?? true,
		clonesDir: path.join(options.dataDir, 'clones'),
		authEnvFor: async (remoteUrl) => {
			const { provider } = parseRemoteUrl(remoteUrl);
			if (provider === 'github')
				return providerAuthEnv(remoteUrl, 'github', await credentials.getGitHubToken());
			if (provider === 'gitlab')
				return providerAuthEnv(remoteUrl, 'gitlab', await credentials.getGitLabToken());
			return {};
		},
		onUpdate: (repository) => events.emit({ type: 'repository.updated', repository })
	});

	const runs = createRunService({
		store,
		events,
		logs: new TaskLogs(path.join(options.dataDir, 'logs')),
		worktreesDir: path.join(options.dataDir, 'worktrees'),
		runAgent:
			options.runAgent ??
			createClaudeAgentRunner({
				executable: options.agentExecutable,
				// Hosts keep saved tokens here (FileSecretStore).
				protectedFiles: [path.join(options.dataDir, 'secrets.json')]
			}),
		getApiKey: credentials.getApiKey,
		providers: {
			githubApiUrl: options.githubApiUrl ?? 'https://api.github.com',
			gitlabApiUrl: options.gitlabApiUrl,
			getGitHubToken: credentials.getGitHubToken,
			getGitLabToken: credentials.getGitLabToken
		},
		ensureCloned: (id) => repositories.clone(id),
		addRepositoryFromUrl: (url) => repositories.addFromUrl(url),
		concurrency: 2
	});
	// If recovery fails (e.g. an unreadable data file), the calls that wait on it report the error.
	const ready = (async () => {
		await runs.recoverInterrupted();
		runs.setConcurrency((await store.read()).settings.concurrency);
	})();
	ready.catch(() => undefined);

	const settings = createSettingsService({
		store,
		credentials,
		envGitHubClientId: options.githubClientId,
		githubAccount: () => githubAuth.account(),
		onConcurrencyChange: (value) => runs.setConcurrency(value)
	});
	const templates = createTemplateService(store);
	const classifyMessage = createMessageClassifier({
		classify:
			options.classifyMode ?? createClaudeModeClassifier({ executable: options.agentExecutable }),
		getApiKey: credentials.getApiKey
	});

	// Keep pull request states fresh in the background (merged, closed). The timer doesn't keep
	// the process alive.
	const syncMs = options.pullRequestSyncMs ?? 5 * 60_000;
	if (syncMs > 0) {
		const timer = setInterval(
			() => void ready.then(() => runs.syncPullRequests()).catch(() => undefined),
			syncMs
		);
		timer.unref?.();
	}

	const afterReady =
		<I, O>(fn: (input: I) => Promise<O>) =>
		async (input: I) => {
			await ready;
			return fn(input);
		};

	return {
		subscribe: (listener) => events.subscribe(listener),

		listRepositories: () => repositories.list(),
		addRepository: ({ path }) => repositories.add(path),
		checkRepository: ({ id }) => repositories.check(id),
		removeRepository: ({ id }) => repositories.remove(id),
		updateRepository: ({ id, checkCommand }) => repositories.update(id, checkCommand),
		listRepositoryCandidates: () => repositories.candidates(),
		addRepositoryFromUrl: ({ url, clone }) => repositories.addFromUrl(url, clone),
		cloneRepository: ({ id }) => repositories.clone(id),
		getEngineInfo: async () => repositories.info(),
		browseFolders: ({ path }) => repositories.browse(path),

		startGitHubLogin: () => githubAuth.start(),
		cancelGitHubLogin: async () => ({ cancelled: githubAuth.cancel() }),
		getGitHubLoginStatus: async () => ({
			pending: githubAuth.pending(),
			account: await githubAuth.account()
		}),
		async signOutGitHub() {
			await githubAuth.signOut();
			return settings.get();
		},
		listGitHubRepositories: () => githubAuth.listRepositories(),

		startRun: afterReady((input) => runs.start(input)),
		listRuns: afterReady(() => runs.list()),
		getRun: afterReady(({ id }) => runs.get(id)),
		getTaskLog: ({ taskId }) => runs.log(taskId),
		getTaskDiff: ({ taskId }) => runs.diff(taskId),
		cancelTask: ({ taskId }) => runs.cancel(taskId),
		discardTask: ({ taskId }) => runs.discard(taskId),
		publishTask: (input) => runs.publish(input),
		runChecks: ({ taskId }) => runs.runChecks(taskId),
		followUpTask: afterReady(({ taskId, instruction }) => runs.followUp(taskId, instruction)),
		switchToChange: afterReady(({ runId, instruction }) => runs.switchToChange(runId, instruction)),
		syncPullRequests: afterReady(() => runs.syncPullRequests()),

		listPullRequests: ({ repositoryId }) => runs.listPullRequests(repositoryId),
		startReview: afterReady((input) => runs.startReview(input)),
		postReview: ({ taskId }) => runs.postReview(taskId),
		startAsk: afterReady(({ repositoryIds, question }) =>
			runs.startReadOnly({ kind: 'ask', repositoryIds, text: question })
		),
		startExplore: afterReady(({ repositoryIds, idea }) =>
			runs.startReadOnly({ kind: 'explore', repositoryIds, text: idea })
		),
		classifyMessage,

		listTemplates: () => templates.list(),
		saveTemplate: (input) => templates.save(input),
		deleteTemplate: ({ id }) => templates.remove(id),

		getSettings: () => settings.get(),
		updateSettings: (update) => settings.update(update)
	};
}

function toErrorData(error: unknown): EngineErrorData {
	if (error instanceof EngineError) return { code: error.code, message: error.message };
	return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}

/**
 * The one entry point every transport uses: validates the method name, calls the engine and
 * turns thrown errors into a serializable result.
 */
export async function handleEngineCall(
	engine: EngineApi,
	method: unknown,
	input: unknown
): Promise<EngineResult<unknown>> {
	if (typeof method !== 'string' || !(engineMethods as readonly string[]).includes(method)) {
		return {
			ok: false,
			error: { code: 'unknown_method', message: `Unknown method: ${String(method)}` }
		};
	}
	if (
		input !== undefined &&
		(typeof input !== 'object' || input === null || Array.isArray(input))
	) {
		return { ok: false, error: { code: 'invalid_input', message: 'Input must be an object.' } };
	}
	try {
		const call = engine[method as keyof EngineApi] as (input: unknown) => Promise<unknown>;
		return { ok: true, value: await call(input ?? {}) };
	} catch (error) {
		return { ok: false, error: toErrorData(error) };
	}
}
