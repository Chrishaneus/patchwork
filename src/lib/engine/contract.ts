/**
 * The contract between the UI and the engine.
 *
 * The engine does the work that needs a real machine (files, git, later the AI agent and PRs).
 * It runs in the Electron main process on desktop, and later behind an HTTP server for the web
 * (Docker) and the native apps. Every host exposes exactly this API through one generic
 * transport: `invoke(method, input)` returning an `EngineResult`. Keep everything here
 * serializable (plain JSON) and free of Node or browser imports.
 */

import type { AgentMode } from './agent-mode.js';

export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'other';

export interface Repository {
	id: string;
	/** Display name, from the remote (`owner/repo`'s repo) or the folder name. */
	name: string;
	/** Absolute path of the repository root (the git top-level directory). */
	path: string;
	remoteName: string;
	remoteUrl: string;
	provider: GitProvider;
	/** `owner/repo` when it can be read from the remote URL. */
	slug: string | null;
	defaultBranch: string;
	addedAt: string;
	/**
	 * Shell command that checks a change, run in the task's working copy after the agent finishes
	 * (e.g. `npm ci && npm test`). Null means no checks.
	 */
	checkCommand: string | null;
	/**
	 * True when the app cloned this repository from a URL and owns the copy (in its data folder);
	 * false for a local folder you added.
	 */
	managed: boolean;
	/**
	 * For repositories added by URL: whether the app's copy exists yet. Cloning happens the first
	 * time a change runs on it, or on request. Null for local folders.
	 */
	cloneStatus: CloneStatus | null;
	/** Why the last clone failed. */
	cloneError: string | null;
}

export type CloneStatus = 'pending' | 'cloning' | 'ready' | 'failed';

/** The signed-in GitHub account (GitHub sign-in through the app's GitHub App). */
export interface GitHubAccount {
	login: string;
	avatarUrl: string | null;
}

/** A repository on GitHub that can be added by cloning it. */
export interface GitHubRepository {
	fullName: string;
	cloneUrl: string;
	private: boolean;
	description: string | null;
	updatedAt: string | null;
}

/** What the engine allows where it runs. */
export interface EngineInfo {
	/**
	 * Desktop: true. Server: true in local mode (PATCHWORK_LOCAL) or when folders are mounted
	 * (PATCHWORK_REPOS); false in plain Docker.
	 */
	localPaths: boolean;
	/** Folders local repositories must be inside; empty means anywhere (desktop). */
	repositoryRoots: string[];
}

export interface FolderEntry {
	name: string;
	path: string;
	/** Whether the folder is the top of a git repository. */
	isGitRepository: boolean;
}

/** One level of the engine's folder browser. */
export interface FolderListing {
	/** The folder shown, or null for the list of allowed roots. */
	path: string | null;
	/** Where "Up" goes: a folder, null for the roots list, or undefined at the top. */
	parent?: string | null;
	isGitRepository: boolean;
	entries: FolderEntry[];
	/** True when there were more folders than shown. */
	truncated: boolean;
}

export interface GitHubLoginStart {
	/** The code to enter on GitHub. */
	userCode: string;
	/** Where to enter it (https://github.com/login/device). */
	verificationUri: string;
	expiresAt: string;
}

export interface RepositoryStatus {
	/** Whether the folder still exists and is still a git repository. */
	available: boolean;
	currentBranch: string | null;
	/** Number of changed or untracked files in the working copy. */
	uncommittedChanges: number;
	checkedAt: string;
}

export interface RepositoryWithStatus extends Repository {
	status: RepositoryStatus;
}

export type TaskStatus =
	| 'queued'
	| 'preparing'
	| 'running'
	| 'checking'
	| 'awaiting_review'
	| 'publishing'
	| 'published'
	| 'failed'
	| 'cancelled'
	| 'discarded'
	/** A read-only workflow (review, explore) finished; its result is on the task. */
	| 'completed';

/** States in which a task is still working. */
export const activeTaskStatuses: readonly TaskStatus[] = [
	'queued',
	'preparing',
	'running',
	'checking',
	'publishing'
];

export interface TaskChecks {
	status: 'running' | 'passed' | 'failed';
	command: string;
	exitCode: number | null;
	/** The end of the command's combined output. */
	output: string;
	startedAt: string;
	finishedAt: string | null;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

/** A GitHub pull request or a GitLab merge request. */
export interface PullRequest {
	provider: 'github' | 'gitlab';
	url: string;
	/** GitHub PR number, or GitLab MR iid. */
	number: number;
	draft: boolean;
	state: PullRequestState;
	/** When the state was last read from the provider. */
	syncedAt: string | null;
}

export interface FollowUp {
	instruction: string;
	at: string;
}

/** A saved instruction to reuse on New change. */
export interface InstructionTemplate {
	id: string;
	name: string;
	instruction: string;
}

export interface DiffStat {
	files: number;
	insertions: number;
	deletions: number;
}

/** One repository's part of a run: its own branch, worktree and agent session. */
export interface Task {
	id: string;
	runId: string;
	repositoryId: string;
	repositoryName: string;
	status: TaskStatus;
	branch: string;
	baseBranch: string;
	/** Commit the branch started from; the diff is taken against it. */
	baseCommit: string | null;
	worktreePath: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	/** The agent's final message, used later as the PR description. */
	summary: string | null;
	error: EngineErrorData | null;
	costUsd: number | null;
	turns: number | null;
	diffStat: DiffStat | null;
	/** The commit that was pushed, once published. */
	commitSha: string | null;
	/** Set when the branch has been pushed to the remote. */
	pushedAt: string | null;
	/** The opened pull request; null when the remote isn't on GitHub (branch pushed only). */
	pullRequest: PullRequest | null;
	/** Why the last publish attempt failed; the task stays in review so it can be retried. */
	publishError: EngineErrorData | null;
	/** Result of the repository's check command; null when it has none. */
	checks: TaskChecks | null;
	/** Follow-up instructions given after the first run, oldest first. */
	followUps: FollowUp[];
	/** Review workflow: the scored review of the pull request. */
	review: ReviewResult | null;
	/** Explore workflow: the approaches the agent found. */
	exploration: Exploration | null;
}

/** Something a review rates from 1 to 5, e.g. "Security". */
export interface ReviewAttribute {
	id: string;
	name: string;
	/** What a good score means, given to the agent. */
	description: string;
}

export interface ReviewScore {
	attribute: string;
	/** 1 (poor) to 5 (excellent). */
	score: number;
	explanation: string;
}

export interface ReviewResult {
	scores: ReviewScore[];
	summary: string;
	verdict: 'approve' | 'comment' | 'request_changes';
	/** Set once the review was posted on GitHub or GitLab. */
	postedUrl: string | null;
}

export interface Approach {
	title: string;
	summary: string;
	/** How it would work, in a few paragraphs or bullet points. */
	details: string;
	files: string[];
	pros: string[];
	cons: string[];
	effort: 'small' | 'medium' | 'large';
}

export interface Exploration {
	approaches: Approach[];
	/** Which approach the agent would pick, and why. */
	recommendation: string;
}

/** What a run does. */
export type RunKind = 'code' | 'review' | 'explore' | 'ask';

/** The pull request a review run looks at. */
export interface ReviewedPullRequest {
	provider: 'github' | 'gitlab';
	url: string;
	number: number;
	title: string;
	baseRef: string;
	headRef: string;
}

/** An open pull request, for picking one to review. */
export interface PullRequestSummary {
	number: number;
	title: string;
	url: string;
	author: string | null;
	headRef: string;
	baseRef: string;
	draft: boolean;
}

export interface PublishInput {
	taskId: string;
	/** PR title, also the first line of the commit message. */
	title: string;
	/** PR description, also the rest of the commit message. */
	body: string;
	draft?: boolean;
}

/** One instruction applied to one or more repositories. */
export interface Run {
	id: string;
	/** Code: the change to make. Review: the PR title. Explore: the idea. */
	instruction: string;
	createdAt: string;
	tasks: Task[];
	/** Runs made before workflows existed are code runs. */
	kind?: RunKind;
	/** Review runs: the pull request under review. */
	pullRequest?: ReviewedPullRequest;
	/** Review runs: the attributes it was rated on. */
	attributes?: ReviewAttribute[];
	/** Review: what the person asked to look at besides the link. */
	focus?: string;
	/** A question or exploration that became a change (`switchToChange`), and when. */
	switchedFrom?: { kind: 'ask' | 'explore'; at: string };
}

export type LogKind = 'info' | 'assistant' | 'tool' | 'result' | 'error';

export interface LogEntry {
	at: string;
	kind: LogKind;
	text: string;
}

export interface TaskDiff {
	stat: DiffStat;
	/** Unified diff against the base commit. */
	patch: string;
	/** True when the patch was cut to keep it a reasonable size. */
	truncated: boolean;
}

export interface Settings {
	model: string;
	/** The agent is stopped after this many minutes. */
	timeoutMinutes: number;
	/** How many tasks may run at the same time. */
	concurrency: number;
	/**
	 * Never the key itself; only whether one is available, where it comes from, and whether a
	 * saved key is encrypted (false when the system has no keychain).
	 */
	anthropicApiKey: { source: 'saved' | 'environment' | null; encrypted: boolean };
	/** The same for the OpenAI key Codex uses (OpenAI models); without one, `codex login`. */
	openaiApiKey: { source: 'saved' | 'environment' | null; encrypted: boolean };
	/** Token used to open pull requests on GitHub (from Settings, or GITHUB_TOKEN / GH_TOKEN). */
	githubToken: { source: 'saved' | 'environment' | null; encrypted: boolean };
	/** Token used to open merge requests on GitLab (from Settings, or GITLAB_TOKEN). */
	gitlabToken: { source: 'saved' | 'environment' | null; encrypted: boolean };
	/** The GitHub App's client ID, needed for "Sign in with GitHub". */
	githubClientId: { value: string | null; source: 'saved' | 'environment' | null };
	/** Who is signed in with GitHub, if anyone. */
	githubAccount: GitHubAccount | null;
	/** The default attributes reviews rate (editable). */
	reviewAttributes: ReviewAttribute[];
	/** Whether each agent's shell commands run in a sandbox here (Claude Code, Codex). */
	agentSandbox: Record<AgentName, SandboxStatus>;
}

export type AgentName = 'claude' | 'codex';

/**
 * When a sandbox isn't available, `missing` names the tools to install (Linux), `blocked` means
 * the system forbids it (e.g. Docker's default seccomp profile), and neither means the system
 * can't (Claude Code on Windows). `setup` means a one-time setup with administrator approval
 * would turn it on (Codex on Windows before 11 24H2), with `setUpAgentSandbox`.
 */
export interface SandboxStatus {
	available: boolean;
	missing: string[];
	blocked: boolean;
	setup: boolean;
}

export interface SettingsUpdate {
	model?: string;
	timeoutMinutes?: number;
	concurrency?: number;
	/** A new key to save, or null to delete the saved key. */
	anthropicApiKey?: string | null;
	/** A new OpenAI key to save, or null to delete the saved key. */
	openaiApiKey?: string | null;
	/** A new GitHub token to save, or null to delete it. */
	githubToken?: string | null;
	/** A new GitLab token to save, or null to delete it. */
	gitlabToken?: string | null;
	/** The GitHub App client ID to use for sign-in, or null to clear it. */
	githubClientId?: string | null;
	reviewAttributes?: ReviewAttribute[];
}

/** Pushed from the engine to the UI while tasks run. */
export type EngineEvent =
	| { type: 'task.updated'; task: Task }
	| { type: 'task.log'; taskId: string; entry: LogEntry }
	/** A run changed besides its tasks (e.g. it switched to a change). */
	| { type: 'run.updated'; run: Run }
	/** Sent by a transport after it reconnects: events may have been missed, reload state. */
	| { type: 'resync' }
	/** A repository changed outside a direct call (e.g. cloned while preparing a run). */
	| { type: 'repository.updated'; repository: RepositoryWithStatus }
	/** GitHub sign-in finished, failed, or the account changed; reload settings. */
	| {
			type: 'github.login';
			status: 'signed_in' | 'signed_out' | 'denied' | 'expired' | 'failed';
			message?: string;
	  };

/** A git repository found in one of the server's repository folders. */
export interface RepositoryCandidate {
	path: string;
	name: string;
}

export interface RepositoryCandidates {
	/** Folders repositories must live in. Empty means anywhere (desktop). */
	roots: string[];
	/** Git repositories found there that aren't added yet. */
	candidates: RepositoryCandidate[];
}

export type EngineErrorCode =
	| 'path_not_found'
	| 'not_a_git_repository'
	| 'no_remote'
	| 'already_added'
	| 'outside_repository_roots'
	| 'local_paths_disabled'
	| 'invalid_url'
	| 'clone_failed'
	| 'github_login_unavailable'
	| 'github_not_signed_in'
	| 'folder_not_found'
	| 'invalid_pull_request'
	| 'unreadable_result'
	| 'repository_not_found'
	| 'repository_unavailable'
	| 'run_not_found'
	| 'task_not_found'
	| 'invalid_state'
	| 'invalid_branch'
	| 'git_failed'
	| 'agent_failed'
	| 'agent_not_signed_in'
	| 'timeout'
	| 'nothing_to_publish'
	| 'git_identity_missing'
	| 'push_failed'
	| 'github_token_missing'
	| 'github_failed'
	| 'gitlab_token_missing'
	| 'gitlab_failed'
	| 'interrupted'
	| 'unauthorized'
	| 'unknown_method'
	| 'invalid_input'
	| 'internal';

export interface EngineErrorData {
	code: EngineErrorCode;
	message: string;
}

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: EngineErrorData };

/** Every engine operation. Each takes one JSON input object and resolves to JSON. */
export interface EngineApi {
	listRepositories(input: Record<string, never>): Promise<RepositoryWithStatus[]>;
	addRepository(input: { path: string }): Promise<RepositoryWithStatus>;
	checkRepository(input: { id: string }): Promise<RepositoryWithStatus>;
	removeRepository(input: { id: string }): Promise<{ id: string }>;
	/** Change a repository's settings; `checkCommand: null` (or empty) turns checks off. */
	updateRepository(input: {
		id: string;
		checkCommand: string | null;
	}): Promise<RepositoryWithStatus>;
	/** On a server: repositories found in the allowed folders, ready to add. */
	listRepositoryCandidates(input: Record<string, never>): Promise<RepositoryCandidates>;
	/**
	 * Add a repository by URL. By default it's only registered (its URL is checked with
	 * `git ls-remote`) and cloned the first time a change runs on it, or with `cloneRepository`.
	 * `clone: true` clones right away.
	 */
	addRepositoryFromUrl(input: { url: string; clone?: boolean }): Promise<RepositoryWithStatus>;
	/** Clone a repository that was added by URL but isn't cloned yet. Returns when done. */
	cloneRepository(input: { id: string }): Promise<RepositoryWithStatus>;
	getEngineInfo(input: Record<string, never>): Promise<EngineInfo>;
	/**
	 * List the folders inside `path` (or the starting point), for picking a local repository from
	 * a UI that can't open a native folder picker (web, mobile). Only where local folders are allowed.
	 */
	browseFolders(input: { path?: string }): Promise<FolderListing>;

	/**
	 * Start "Sign in with GitHub" (device flow). Show the code to the user; the result arrives as a
	 * `github.login` event once they approve on GitHub (or it expires).
	 */
	startGitHubLogin(input: Record<string, never>): Promise<GitHubLoginStart>;
	cancelGitHubLogin(input: Record<string, never>): Promise<{ cancelled: boolean }>;
	/**
	 * Whether a sign-in is still waiting for approval, and who is signed in. The UI checks this as
	 * a fallback, e.g. when the engine restarted and the waiting sign-in is gone.
	 */
	getGitHubLoginStatus(
		input: Record<string, never>
	): Promise<{ pending: boolean; account: GitHubAccount | null }>;
	signOutGitHub(input: Record<string, never>): Promise<Settings>;
	/** Repositories the signed-in account can use through the app, most recently updated first. */
	listGitHubRepositories(input: Record<string, never>): Promise<GitHubRepository[]>;

	/** Start a run. Returns at once; progress arrives as `EngineEvent`s. */
	startRun(input: { repositoryIds: string[]; instruction: string; branch?: string }): Promise<Run>;
	listRuns(input: Record<string, never>): Promise<Run[]>;
	getRun(input: { id: string }): Promise<Run>;
	getTaskLog(input: { taskId: string }): Promise<LogEntry[]>;
	getTaskDiff(input: { taskId: string }): Promise<TaskDiff>;
	/** Stop a queued or running task. Its worktree is kept so the partial work can be reviewed. */
	cancelTask(input: { taskId: string }): Promise<Task>;
	/** Delete a finished task's worktree and branch. */
	discardTask(input: { taskId: string }): Promise<Task>;
	/**
	 * Commit the reviewed changes, push the branch and open a pull request (GitHub). Returns once
	 * done; the task is `published` afterwards, or back in review with `publishError` set.
	 */
	publishTask(input: PublishInput): Promise<Task>;
	/** Run the repository's check command again on a task that's in review. Returns once done. */
	runChecks(input: { taskId: string }): Promise<Task>;
	/**
	 * Ask the agent for more changes on a task that has a working copy (in review, failed or
	 * cancelled). Returns at once; the task runs again and comes back to review.
	 */
	followUpTask(input: { taskId: string; instruction: string }): Promise<Task>;
	/**
	 * Turn a finished Ask or Explore conversation into a change, in the same conversation: each
	 * repository gets a branch and a working copy, and the agent makes `instruction` knowing what
	 * was asked and answered. Returns at once; the tasks come back to review like any change.
	 */
	switchToChange(input: { runId: string; instruction: string }): Promise<Run>;
	/** Read the state (open, merged, closed) of every open pull request from its provider. */
	syncPullRequests(input: Record<string, never>): Promise<{ updated: number }>;

	listTemplates(input: Record<string, never>): Promise<InstructionTemplate[]>;
	/** Create a template, or update it when `id` is given. */
	saveTemplate(input: {
		id?: string;
		name: string;
		instruction: string;
	}): Promise<InstructionTemplate>;
	deleteTemplate(input: { id: string }): Promise<{ id: string }>;

	/** Open pull requests (GitHub) or merge requests (GitLab) of a repository. */
	listPullRequests(input: { repositoryId: string }): Promise<PullRequestSummary[]>;
	/**
	 * Review a pull request: by URL (the repository is added if needed) or by repository and
	 * number. Returns at once; the scored review lands on the task.
	 */
	startReview(input: {
		url?: string;
		repositoryId?: string;
		number?: number;
		attributes: ReviewAttribute[];
		/** Your message, shown in the conversation; text besides the link is passed to the agent. */
		instruction?: string;
	}): Promise<Run>;
	/** Post a finished review on GitHub or GitLab as a comment. */
	postReview(input: { taskId: string }): Promise<Task>;
	/** Explore ways to implement an idea, read-only; the approaches land on each task. */
	startExplore(input: { repositoryIds: string[]; idea: string }): Promise<Run>;
	/** Ask a question about the code, read-only; the answer is the task's summary. */
	startAsk(input: { repositoryIds: string[]; question: string }): Promise<Run>;
	/**
	 * Auto mode: which workflow a first message asks for, decided by a small model. `source` is
	 * `rules` when the keyword rules answered instead (a pull request link, or no model available).
	 */
	classifyMessage(input: { text: string }): Promise<{ mode: AgentMode; source: 'ai' | 'rules' }>;

	getSettings(input: Record<string, never>): Promise<Settings>;
	updateSettings(input: SettingsUpdate): Promise<Settings>;
	/**
	 * Set up an agent's sandbox when its status says `setup` (Codex on Windows): the system asks
	 * for administrator approval. Returns once done, with the sandbox checked again.
	 */
	setUpAgentSandbox(input: { agent: AgentName }): Promise<Settings>;
}

export type EngineMethod = keyof EngineApi;
export type EngineInput<M extends EngineMethod> = Parameters<EngineApi[M]>[0];
export type EngineOutput<M extends EngineMethod> = Awaited<ReturnType<EngineApi[M]>>;

export const engineMethods: readonly EngineMethod[] = [
	'listRepositories',
	'addRepository',
	'checkRepository',
	'removeRepository',
	'updateRepository',
	'listRepositoryCandidates',
	'addRepositoryFromUrl',
	'cloneRepository',
	'getEngineInfo',
	'browseFolders',
	'startGitHubLogin',
	'cancelGitHubLogin',
	'getGitHubLoginStatus',
	'signOutGitHub',
	'listGitHubRepositories',
	'startRun',
	'listRuns',
	'getRun',
	'getTaskLog',
	'getTaskDiff',
	'cancelTask',
	'discardTask',
	'publishTask',
	'runChecks',
	'followUpTask',
	'switchToChange',
	'syncPullRequests',
	'listTemplates',
	'saveTemplate',
	'deleteTemplate',
	'listPullRequests',
	'startReview',
	'postReview',
	'startExplore',
	'startAsk',
	'classifyMessage',
	'getSettings',
	'updateSettings',
	'setUpAgentSandbox'
];

/** Error with a stable code that survives the trip across IPC/HTTP as `EngineErrorData`. */
export class EngineError extends Error {
	readonly code: EngineErrorCode;

	constructor(code: EngineErrorCode, message: string) {
		super(message);
		this.name = 'EngineError';
		this.code = code;
	}
}

/**
 * Host features that depend on where the app runs, separate from the engine itself.
 * Desktop can show a native folder picker; other hosts fall back to typing a path.
 */
export interface HostCapabilities {
	pickDirectory?: () => Promise<string | null>;
}

/** The low-level transport every host provides. */
export type EngineTransport = (
	method: EngineMethod,
	input: unknown
) => Promise<EngineResult<unknown>>;

/** Subscribe to engine events; returns an unsubscribe function. */
export type EngineEventSource = (listener: (event: EngineEvent) => void) => () => void;
