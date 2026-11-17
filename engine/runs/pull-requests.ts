import { EngineError, type Repository, type ReviewedPullRequest } from '#lib/engine/contract.js';
import { parseRemoteUrl } from '../git/git.js';
import { providerFor, type ReviewFeedback } from '../providers/index.js';
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

/** At most this much review text in the prompt; a long review is cut, with a note. */
const MAX_FEEDBACK = 40_000;

/** Review comments as Markdown for the agent: who, where, what, and the replies. */
export function feedbackMarkdown(items: ReviewFeedback[]): string {
	const quote = (text: string) =>
		text
			.trim()
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');
	const text = items
		.map((item, i) => {
			const where = item.path ? ` on \`${item.path}\`${item.line ? ` line ${item.line}` : ''}` : '';
			const replies = (item.replies ?? []).map(
				(r) => `Reply from ${r.author ?? 'someone'}:\n\n${quote(r.body)}`
			);
			return [
				`${i + 1}. ${item.author ?? 'A reviewer'}${where}:`,
				quote(item.body),
				...replies
			].join('\n\n');
		})
		.join('\n\n');
	return text.length > MAX_FEEDBACK
		? `${text.slice(0, MAX_FEEDBACK)}\n\n(The review is longer; the rest was left out.)`
		: text;
}

/**
 * The pull request a change goes to, to address its review: its repository (added if needed),
 * its branches, and its review comments (one review or thread if the link points at it).
 * Refuses a pull request from a fork, whose branch can't be pushed to, and one without comments.
 */
export async function findPullRequestToUpdate(ctx: RunContext, url: string) {
	const { repo, number } = await repositoryForPullRequest(ctx, url);
	const { provider, slug } = await providerOf(ctx, repo);
	const details = await provider.get(slug, number);
	const label = provider.kind === 'gitlab' ? `Merge request !${number}` : `Pull request #${number}`;
	if (details.fromFork) {
		throw new EngineError(
			'invalid_pull_request',
			`${label} comes from a fork, so its branch can’t be pushed to from here.`
		);
	}
	const anchor = new URL(url.trim()).hash.replace(/^#/, '') || null;
	const feedback = await provider.feedback(slug, number, anchor);
	if (feedback.length === 0) {
		throw new EngineError('invalid_pull_request', `${label} has no review comments to address.`);
	}
	const pullRequest: ReviewedPullRequest = {
		provider: provider.kind,
		url: details.url,
		number,
		title: details.title,
		baseRef: details.baseRef,
		headRef: details.headRef,
		repositoryId: repo.id
	};
	return { repo, pullRequest, feedback: feedbackMarkdown(feedback) };
}
