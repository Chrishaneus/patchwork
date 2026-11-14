import {
	EngineError,
	type PullRequest,
	type PullRequestState,
	type PullRequestSummary,
	type Repository
} from '#lib/engine/contract.js';
import { parseRemoteUrl } from '../git/git.js';
import { createGitHubClient, type OpenPullRequestInput } from './github.js';
import { createGitLabClient } from './gitlab.js';

export interface ProviderSettings {
	githubApiUrl: string;
	/** Overrides the GitLab API URL (otherwise https://<remote host>/api/v4). */
	gitlabApiUrl?: string;
	getGitHubToken: () => Promise<string | null>;
	getGitLabToken: () => Promise<string | null>;
}

export interface ProviderClient {
	kind: 'github' | 'gitlab';
	token: string;
	openPullRequest(input: OpenPullRequestInput): Promise<PullRequest>;
	getState(slug: string, number: number): Promise<PullRequestState>;
	get(
		slug: string,
		number: number
	): Promise<{
		title: string;
		url: string;
		baseRef: string;
		headRef: string;
		headSha: string | null;
	}>;
	listOpen(slug: string): Promise<PullRequestSummary[]>;
	comment(slug: string, number: number, body: string): Promise<string>;
	/**
	 * Post a review with comments on lines of the pull request. `body(notInline)` is the main
	 * comment, given the comments that couldn't go on their lines. Returns its link and those.
	 */
	review(slug: string, number: number, input: ReviewInput): Promise<PostedReview>;
}

/** A comment on lines of a pull request's new version, its text ready for the provider. */
export interface InlineComment {
	path: string;
	startLine: number;
	line: number;
	body: string;
}

export interface ReviewInput<C extends InlineComment = InlineComment> {
	/** The commit reviewed, which the lines refer to; null to use the current head. */
	headSha: string | null;
	comments: C[];
	body: (notInline: C[]) => string;
}

export interface PostedReview<C extends InlineComment = InlineComment> {
	url: string;
	/** Comments the provider wouldn't place on their lines; they're in the main comment. */
	notInline: C[];
}

/** The ref a pull request's head can be fetched from, on the base repository. */
export const pullRequestRef = (kind: 'github' | 'gitlab', number: number) =>
	kind === 'github' ? `pull/${number}/head` : `merge-requests/${number}/head`;

/** Whether pull requests can be opened for this repository (a known provider and a slug). */
export const supportsPullRequests = (repo: Repository) =>
	(repo.provider === 'github' || repo.provider === 'gitlab') && !!repo.slug;

/**
 * The API client for a repository's provider, with its token. Returns null for remotes without
 * pull request support (they're pushed only). Throws when the token is missing.
 */
export async function providerFor(
	repo: Repository,
	settings: ProviderSettings
): Promise<ProviderClient | null> {
	if (!supportsPullRequests(repo)) return null;
	if (repo.provider === 'github') {
		const token = await settings.getGitHubToken();
		if (!token) {
			throw new EngineError(
				'github_token_missing',
				'Add a GitHub token in Settings (or set GITHUB_TOKEN) to open pull requests.'
			);
		}
		return {
			kind: 'github',
			token,
			...createGitHubClient({ apiUrl: settings.githubApiUrl, token })
		};
	}
	const token = await settings.getGitLabToken();
	if (!token) {
		throw new EngineError(
			'gitlab_token_missing',
			'Add a GitLab token in Settings (or set GITLAB_TOKEN) to open merge requests.'
		);
	}
	const host = parseRemoteUrl(repo.remoteUrl).host || 'gitlab.com';
	const apiUrl = settings.gitlabApiUrl ?? `https://${host}/api/v4`;
	return { kind: 'gitlab', token, ...createGitLabClient({ apiUrl, token }) };
}

/**
 * git config that sends the provider token with HTTPS requests to its host, the way CI checkouts
 * do. Passed through GIT_CONFIG_* environment variables so the token never appears in a command
 * line, an error message or a log.
 */
export function providerAuthEnv(
	remoteUrl: string,
	kind: 'github' | 'gitlab' | null,
	token: string | null
): Record<string, string> {
	if (!token || !kind) return {};
	const match = /^https:\/\/([^/@]+)\//i.exec(remoteUrl);
	if (!match) return {};
	const host = match[1].toLowerCase();
	if (kind === 'github' && host !== 'github.com') return {};
	const user = kind === 'github' ? 'x-access-token' : 'oauth2';
	const basic = Buffer.from(`${user}:${token}`).toString('base64');
	return {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
	};
}
