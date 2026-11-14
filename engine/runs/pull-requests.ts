import { EngineError, type Repository, type ReviewedPullRequest } from '#lib/engine/contract.js';
import { parseRemoteUrl } from '../git/git.js';
import { providerFor } from '../providers/index.js';
import type { RunContext } from './context.js';
import { parsePullRequestUrl } from './workflows.js';

/** The GitHub/GitLab client for a repository that supports pull requests. */
async function providerOf(ctx: RunContext, repo: Repository) {
	const provider = await providerFor(repo, ctx.deps.providers);
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
	ctx: RunContext,
	url: string
): Promise<{ repo: Repository; number: number }> {
	const pr = parsePullRequestUrl(url);
	const hostname = new URL(url.trim()).hostname.toLowerCase();
	const matches = (r: Repository) => {
		const remote = parseRemoteUrl(r.remoteUrl);
		return (
			remote.host.toLowerCase() === hostname && remote.slug?.toLowerCase() === pr.slug.toLowerCase()
		);
	};
	const { repositories: known } = await ctx.store.read();
	// Prefer a local folder you added, then the app's own copy.
	const existing = known.find((r) => matches(r) && !r.managed) ?? known.find(matches);
	if (existing) return { repo: existing, number: pr.number };
	const protocol = new URL(url.trim()).protocol;
	const added = await ctx.deps.addRepositoryFromUrl(`${protocol}//${pr.host}/${pr.slug}.git`);
	return { repo: added, number: pr.number };
}

/** Open pull requests (GitHub) or merge requests (GitLab) of a repository. */
export async function listPullRequests(ctx: RunContext, repositoryId: string) {
	const repo = await ctx.findRepository(repositoryId);
	if (!repo) throw new EngineError('repository_not_found', 'The repository was removed.');
	const { provider, slug } = await providerOf(ctx, repo);
	return provider.listOpen(slug);
}

/** The repository and pull request to review: from a link, or a repository and a number. */
export async function findPullRequestToReview(
	ctx: RunContext,
	input: { url?: string; repositoryId?: string; number?: number }
): Promise<{ repo: Repository; pullRequest: ReviewedPullRequest }> {
	let repo: Repository | undefined;
	let number: number;
	if (input.url?.trim()) {
		({ repo, number } = await repositoryForPullRequest(ctx, input.url));
	} else {
		repo = input.repositoryId ? await ctx.findRepository(input.repositoryId) : undefined;
		if (!repo) throw new EngineError('repository_not_found', 'Choose a repository.');
		if (!Number.isInteger(input.number) || (input.number ?? 0) < 1) {
			throw new EngineError('invalid_pull_request', 'Choose a pull request.');
		}
		number = input.number!;
	}
	const { provider, slug } = await providerOf(ctx, repo);
	const details = await provider.get(slug, number);
	return {
		repo,
		pullRequest: {
			provider: provider.kind,
			url: details.url,
			number,
			title: details.title,
			baseRef: details.baseRef,
			headRef: details.headRef,
			repositoryId: repo.id
		}
	};
}

/** At most this many pull requests in one review. */
export const MAX_REVIEWED_PULL_REQUESTS = 6;

/**
 * The pull requests to review together, in the order given, each found (or its repository
 * added) like a single one; the same pull request twice counts once.
 */
export async function findPullRequestsToReview(
	ctx: RunContext,
	inputs: { url?: string; repositoryId?: string; number?: number }[]
) {
	if (!Array.isArray(inputs) || inputs.length === 0) {
		throw new EngineError('invalid_pull_request', 'Choose a pull request.');
	}
	if (inputs.length > MAX_REVIEWED_PULL_REQUESTS) {
		throw new EngineError(
			'invalid_input',
			`Review at most ${MAX_REVIEWED_PULL_REQUESTS} pull requests at once.`
		);
	}
	const found: { repo: Repository; pullRequest: ReviewedPullRequest }[] = [];
	for (const input of inputs) {
		const next = await findPullRequestToReview(ctx, input ?? {});
		if (!found.some((f) => f.pullRequest.url === next.pullRequest.url)) found.push(next);
	}
	return found;
}
