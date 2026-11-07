import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
	EngineError,
	engineMethods,
	type EngineApi,
	type EngineErrorData,
	type EngineEvent,
	type EngineResult,
	type Repository,
	type Settings
} from '#lib/engine/contract.js';
import { detectAgentMode, findPullRequestLink } from '#lib/agent-mode.js';
import { createClaudeAgentRunner, type AgentRunner } from './agent/runner.js';
import { createClaudeModeClassifier, type ModeClassifier } from './agent/classifier.js';
import { EngineEvents } from './core/events.js';
import { TaskLogs } from './core/logs.js';
import { parseRemoteUrl } from './git/git.js';
import { createGitHubAuth } from './providers/github-auth.js';
import { providerAuthEnv, providerFor } from './providers/index.js';
import {
	cleanAttributes,
	defaultReviewAttributes,
	parsePullRequestUrl,
	reviewFocus
} from './runs/workflows.js';
import { createRepositoryService } from './repositories/index.js';
import { createRunService } from './runs/index.js';
import { MemorySecretStore, type SecretStore } from './core/secrets.js';
import { JsonStore } from './core/store.js';

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

const API_KEY = 'anthropicApiKey';
const GITHUB_TOKEN = 'githubToken';
const GITLAB_TOKEN = 'gitlabToken';
/** Long enough to read the intent; the rest of a long message doesn't change it. */
const MAX_CLASSIFY_CHARS = 4000;
const CLASSIFY_TIMEOUT_MS = 15_000;

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

	const getApiKey = async () =>
		(await secrets.get(API_KEY)) ?? process.env.ANTHROPIC_API_KEY ?? null;
	const classifyMode =
		options.classifyMode ?? createClaudeModeClassifier({ executable: options.agentExecutable });
	const envGitHubToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
	// GitHub sign-in first, then a saved token, then the environment.
	const getGitHubToken = async () =>
		(await githubAuth.token()) ?? (await secrets.get(GITHUB_TOKEN)) ?? envGitHubToken();
	const envGitLabToken = () => process.env.GITLAB_TOKEN || null;
	const getGitLabToken = async () => (await secrets.get(GITLAB_TOKEN)) ?? envGitLabToken();

	const providerSettings = {
		githubApiUrl: options.githubApiUrl ?? 'https://api.github.com',
		gitlabApiUrl: options.gitlabApiUrl,
		getGitHubToken,
		getGitLabToken
	};
	const repositories = createRepositoryService(store, {
		roots: options.repositoryRoots,
		localPaths: options.localPaths ?? true,
		clonesDir: path.join(options.dataDir, 'clones'),
		authEnvFor: async (remoteUrl) => {
			const { provider } = parseRemoteUrl(remoteUrl);
			if (provider === 'github')
				return providerAuthEnv(remoteUrl, 'github', await getGitHubToken());
			if (provider === 'gitlab')
				return providerAuthEnv(remoteUrl, 'gitlab', await getGitLabToken());
			return {};
		},
		onUpdate: (repository) => events.emit({ type: 'repository.updated', repository })
	});

	const runs = createRunService({
		store,
		events,
		logs: new TaskLogs(path.join(options.dataDir, 'logs')),
		worktreesDir: path.join(options.dataDir, 'worktrees'),
		runAgent: options.runAgent ?? createClaudeAgentRunner({ executable: options.agentExecutable }),
		getApiKey,
		providers: providerSettings,
		ensureCloned: (id) => repositories.clone(id),
		concurrency: 2
	});
	// If recovery fails (e.g. an unreadable data file), the calls that wait on it report the error.
	const ready = (async () => {
		await runs.recoverInterrupted();
		runs.setConcurrency((await store.read()).settings.concurrency);
	})();
	ready.catch(() => undefined);

	async function getSettings(): Promise<Settings> {
		const { settings } = await store.read();
		const saved = await secrets.get(API_KEY);
		return {
			model: settings.model,
			timeoutMinutes: settings.timeoutMinutes,
			concurrency: settings.concurrency,
			anthropicApiKey: {
				source: saved ? 'saved' : process.env.ANTHROPIC_API_KEY ? 'environment' : null,
				encrypted: secrets.encrypted
			},
			githubToken: {
				source: (await secrets.get(GITHUB_TOKEN))
					? 'saved'
					: envGitHubToken()
						? 'environment'
						: null,
				encrypted: secrets.encrypted
			},
			gitlabToken: {
				source: (await secrets.get(GITLAB_TOKEN))
					? 'saved'
					: envGitLabToken()
						? 'environment'
						: null,
				encrypted: secrets.encrypted
			},
			githubClientId: settings.githubClientId
				? { value: settings.githubClientId, source: 'saved' }
				: options.githubClientId
					? { value: options.githubClientId, source: 'environment' }
					: { value: null, source: null },
			githubAccount: await githubAuth.account(),
			reviewAttributes: settings.reviewAttributes ?? defaultReviewAttributes
		};
	}

	/** Explore and Ask: validate, then queue a read-only run on the chosen repositories. */
	async function startReadOnly(kind: 'explore' | 'ask', repositoryIds: string[], text: string) {
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
		return runs.startExplore({ repos, idea: text.trim(), kind });
	}

	/** The GitHub/GitLab client for a repository that supports pull requests. */
	async function providerOf(repo: Repository) {
		const provider = await providerFor(repo, providerSettings);
		if (!provider || !repo.slug) {
			throw new EngineError(
				'invalid_input',
				`${repo.name} isn’t on GitHub or GitLab, so it has no pull requests to review.`
			);
		}
		return { provider, slug: repo.slug };
	}

	/** Find the repository a pull request link points at; add it (by URL, not cloned) if needed. */
	async function repositoryForPullRequest(
		url: string
	): Promise<{ repo: Repository; number: number }> {
		const pr = parsePullRequestUrl(url);
		const hostname = new URL(url.trim()).hostname.toLowerCase();
		const matches = (r: Repository) => {
			const remote = parseRemoteUrl(r.remoteUrl);
			return (
				remote.host.toLowerCase() === hostname &&
				remote.slug?.toLowerCase() === pr.slug.toLowerCase()
			);
		};
		const { repositories: known } = await store.read();
		// Prefer a local folder you added, then the app's own copy.
		const existing = known.find((r) => matches(r) && !r.managed) ?? known.find(matches);
		if (existing) return { repo: existing, number: pr.number };
		const protocol = new URL(url.trim()).protocol;
		const added = await repositories.addFromUrl(`${protocol}//${pr.host}/${pr.slug}.git`);
		return { repo: added, number: pr.number };
	}

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
			return getSettings();
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
		syncPullRequests: afterReady(() => runs.syncPullRequests()),

		async listPullRequests({ repositoryId }) {
			const repo = (await store.read()).repositories.find((r) => r.id === repositoryId);
			if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
			const { provider, slug } = await providerOf(repo);
			return provider.listOpen(slug);
		},
		startReview: afterReady(async ({ url, repositoryId, number, attributes, instruction }) => {
			const chosen = cleanAttributes(attributes);
			let repo: Repository | undefined;
			let prNumber: number;
			if (url?.trim()) {
				({ repo, number: prNumber } = await repositoryForPullRequest(url));
			} else {
				repo = (await store.read()).repositories.find((r) => r.id === repositoryId);
				if (!repo) throw new EngineError('repository_not_found', 'Choose a repository.');
				if (!Number.isInteger(number) || (number ?? 0) < 1) {
					throw new EngineError('invalid_pull_request', 'Choose a pull request.');
				}
				prNumber = number!;
			}
			const { provider, slug } = await providerOf(repo);
			const details = await provider.get(slug, prNumber);
			return runs.startReview({
				repo,
				pullRequest: {
					provider: provider.kind,
					url: details.url,
					number: prNumber,
					title: details.title,
					baseRef: details.baseRef,
					headRef: details.headRef
				},
				attributes: chosen,
				instruction: instruction?.trim() || undefined,
				// Whatever you wrote besides the link is for the agent.
				focus: reviewFocus(instruction)
			});
		}),
		postReview: ({ taskId }) => runs.postReview(taskId),
		startAsk: afterReady(({ repositoryIds, question }) =>
			startReadOnly('ask', repositoryIds, question)
		),
		startExplore: afterReady(({ repositoryIds, idea }) =>
			startReadOnly('explore', repositoryIds, idea)
		),
		async classifyMessage({ text }) {
			if (typeof text !== 'string') throw new EngineError('invalid_input', 'Write a message.');
			const message = text.trim().slice(0, MAX_CLASSIFY_CHARS);
			// A pull request link is always a review, and Review needs the link anyway.
			if (!message || findPullRequestLink(message)) {
				return { mode: detectAgentMode(message), source: 'rules' };
			}
			try {
				const mode = await classifyMode({
					text: message,
					apiKey: await getApiKey(),
					signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
				});
				return { mode, source: 'ai' };
			} catch {
				return { mode: detectAgentMode(message), source: 'rules' };
			}
		},

		async listTemplates() {
			return [...(await store.read()).templates].sort((a, b) => a.name.localeCompare(b.name));
		},
		async saveTemplate({ id, name, instruction }) {
			const cleanName = name?.trim();
			const cleanInstruction = instruction?.trim();
			if (!cleanName || !cleanInstruction) {
				throw new EngineError('invalid_input', 'A template needs a name and an instruction.');
			}
			return store.update((data) => {
				const existing = id ? data.templates.find((t) => t.id === id) : undefined;
				if (id && !existing) throw new EngineError('invalid_input', `Unknown template: ${id}`);
				if (existing) {
					existing.name = cleanName;
					existing.instruction = cleanInstruction;
					return { ...existing };
				}
				const created = { id: randomUUID(), name: cleanName, instruction: cleanInstruction };
				data.templates.push(created);
				return created;
			});
		},
		async deleteTemplate({ id }) {
			await store.update((data) => {
				data.templates = data.templates.filter((t) => t.id !== id);
			});
			return { id };
		},

		getSettings: () => getSettings(),
		async updateSettings(update) {
			if (update.model !== undefined) {
				if (!update.model.trim()) throw new EngineError('invalid_input', 'Choose a model.');
			}
			if (update.timeoutMinutes !== undefined) {
				const t = update.timeoutMinutes;
				if (!Number.isInteger(t) || t < 1 || t > 240) {
					throw new EngineError('invalid_input', 'The time limit must be 1–240 minutes.');
				}
			}
			if (update.concurrency !== undefined) {
				const c = update.concurrency;
				if (!Number.isInteger(c) || c < 1 || c > 8) {
					throw new EngineError('invalid_input', 'Tasks at the same time must be 1–8.');
				}
			}
			const reviewAttributes =
				update.reviewAttributes !== undefined
					? cleanAttributes(update.reviewAttributes)
					: undefined;
			await store.update((data) => {
				if (reviewAttributes) data.settings.reviewAttributes = reviewAttributes;
				if (update.model !== undefined) data.settings.model = update.model.trim();
				if (update.timeoutMinutes !== undefined)
					data.settings.timeoutMinutes = update.timeoutMinutes;
				if (update.concurrency !== undefined) data.settings.concurrency = update.concurrency;
			});
			if (update.anthropicApiKey !== undefined) {
				await secrets.set(API_KEY, update.anthropicApiKey?.trim() || null);
			}
			if (update.concurrency !== undefined) runs.setConcurrency(update.concurrency);
			if (update.githubToken !== undefined) {
				await secrets.set(GITHUB_TOKEN, update.githubToken?.trim() || null);
			}
			if (update.gitlabToken !== undefined) {
				await secrets.set(GITLAB_TOKEN, update.gitlabToken?.trim() || null);
			}
			if (update.githubClientId !== undefined) {
				const id = update.githubClientId?.trim() || null;
				if (id && !/^[A-Za-z0-9._-]{8,64}$/.test(id)) {
					throw new EngineError('invalid_input', 'That doesn’t look like a GitHub App client ID.');
				}
				await store.update((data) => {
					data.settings.githubClientId = id;
				});
			}
			return getSettings();
		}
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
