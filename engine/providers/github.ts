import {
	EngineError,
	type PullRequest,
	type PullRequestState,
	type PullRequestSummary
} from '#lib/engine/contract.js';
import type { InlineComment, PostedReview, ReviewFeedback, ReviewInput } from './index.js';

export interface OpenPullRequestInput {
	/** `owner/name` */
	slug: string;
	head: string;
	base: string;
	title: string;
	body: string;
	draft: boolean;
}

interface GitHubPull {
	html_url: string;
	number: number;
	draft?: boolean;
	state?: 'open' | 'closed';
	merged?: boolean;
	merged_at?: string | null;
}

const toPullRequest = (pull: GitHubPull): PullRequest => ({
	provider: 'github',
	url: pull.html_url,
	number: pull.number,
	draft: Boolean(pull.draft),
	state: pull.merged || pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
	syncedAt: new Date().toISOString()
});

/**
 * Minimal GitHub REST client for opening pull requests. `apiUrl` is https://api.github.com, a
 * GitHub Enterprise API URL, or the local fake GitHub used for testing.
 */
export function createGitHubClient(opts: { apiUrl: string; token: string }) {
	const request = async (method: string, path: string, body?: unknown) => {
		let res: Response;
		try {
			res = await fetch(`${opts.apiUrl.replace(/\/$/, '')}${path}`, {
				method,
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${opts.token}`,
					'x-github-api-version': '2022-11-28',
					'user-agent': 'patchwork',
					...(body ? { 'content-type': 'application/json' } : {})
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(30_000)
			});
		} catch (error) {
			throw new EngineError('github_failed', `Could not reach GitHub: ${(error as Error).message}`);
		}
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: res.status, data };
	};

	const describe = (data: Record<string, unknown>) => {
		const errors = Array.isArray(data.errors)
			? (data.errors as { message?: string; field?: string; code?: string }[])
					.map((e) => e.message ?? `${e.field} ${e.code}`)
					.join('; ')
			: '';
		return [data.message, errors].filter(Boolean).join(': ');
	};

	return {
		async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
			const created = await request('POST', `/repos/${input.slug}/pulls`, {
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
				draft: input.draft
			});
			if (created.status === 201) {
				return toPullRequest(created.data as unknown as GitHubPull);
			}

			// Publishing again after a partial failure: reuse the PR that already exists.
			if (created.status === 422 && /already exists/i.test(describe(created.data))) {
				const owner = input.slug.split('/')[0];
				const existing = await request(
					'GET',
					`/repos/${input.slug}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&state=open`
				);
				const [pull] = (Array.isArray(existing.data) ? existing.data : []) as GitHubPull[];
				if (pull) return toPullRequest(pull);
			}

			const hint =
				created.status === 401
					? ' Check the GitHub token in Settings.'
					: created.status === 403 || created.status === 404
						? ' The token may not have access to this repository (it needs pull request write access).'
						: '';
			throw new EngineError(
				'github_failed',
				`GitHub refused the pull request (${created.status}): ${describe(created.data) || 'unknown error'}.${hint}`
			);
		},

		/** Current state of a pull request. */
		async getState(slug: string, number: number): Promise<PullRequestState> {
			const res = await request('GET', `/repos/${slug}/pulls/${number}`);
			if (res.status !== 200) {
				throw new EngineError(
					'github_failed',
					`GitHub couldn't read pull request #${number} (${res.status}): ${describe(res.data)}`
				);
			}
			return toPullRequest(res.data as unknown as GitHubPull).state;
		},

		/** One pull request: title, branches and head commit. */
		async get(slug: string, number: number) {
			const res = await request('GET', `/repos/${slug}/pulls/${number}`);
			if (res.status !== 200) {
				throw new EngineError(
					'invalid_pull_request',
					`GitHub couldn't find pull request #${number} in ${slug} (${res.status}).`
				);
			}
			const pr = res.data as {
				title: string;
				html_url: string;
				base: { ref: string; repo?: { full_name: string } | null };
				head: { ref: string; sha?: string; repo?: { full_name: string } | null };
			};
			const head = pr.head.repo;
			const base = pr.base.repo;
			return {
				title: pr.title,
				url: pr.html_url,
				baseRef: pr.base.ref,
				headRef: pr.head.ref,
				headSha: pr.head.sha ?? null,
				// A null head repository is a fork that was deleted.
				fromFork:
					head === null ||
					(!!head && !!base && head.full_name.toLowerCase() !== base.full_name.toLowerCase())
			};
		},

		async feedback(slug: string, number: number, anchor?: string | null) {
			const list = async <T>(path: string): Promise<T[]> => {
				const res = await request('GET', path);
				if (res.status !== 200 || !Array.isArray(res.data)) {
					throw new EngineError(
						'github_failed',
						`GitHub couldn't read the review of pull request #${number} (${res.status}): ${describe(res.data)}`
					);
				}
				return res.data as T[];
			};
			type Comment = {
				id: number;
				in_reply_to_id?: number;
				path?: string;
				line?: number | null;
				original_line?: number | null;
				body: string;
				user?: { login?: string } | null;
			};
			type Review = { body?: string | null; user?: { login?: string } | null };
			const author = (c: { user?: { login?: string } | null }) => c.user?.login ?? null;
			// Threads: comments that don't reply to one in the list, each with its replies.
			const threads = (comments: Comment[]): ReviewFeedback[] => {
				const ids = new Set(comments.map((c) => c.id));
				return comments
					.filter((c) => !c.in_reply_to_id || !ids.has(c.in_reply_to_id))
					.map((c) => ({
						author: author(c),
						body: c.body,
						path: c.path ?? null,
						// No line when the code it was on has changed since.
						line: c.line ?? c.original_line ?? null,
						replies: comments
							.filter((r) => r.in_reply_to_id === c.id)
							.map((r) => ({ author: author(r), body: r.body }))
					}));
			};
			const main = (reviews: Review[]): ReviewFeedback[] =>
				reviews
					.filter((r) => r.body?.trim())
					.map((r) => ({ author: author(r), body: r.body!.trim() }));
			const pull = `/repos/${slug}/pulls/${number}`;

			const review = /^pullrequestreview-(\d+)$/.exec(anchor ?? '');
			if (review) {
				const res = await request('GET', `${pull}/reviews/${review[1]}`);
				if (res.status !== 200) {
					throw new EngineError(
						'invalid_pull_request',
						`GitHub couldn't find that review on pull request #${number} (${res.status}).`
					);
				}
				const comments = await list<Comment>(`${pull}/reviews/${review[1]}/comments?per_page=100`);
				return [...main([res.data as Review]), ...threads(comments)];
			}
			const comments = await list<Comment>(`${pull}/comments?per_page=100`);
			const thread = /^discussion_r(\d+)$/.exec(anchor ?? '');
			if (thread) {
				const picked = comments.find((c) => c.id === Number(thread[1]));
				const root = picked?.in_reply_to_id ?? Number(thread[1]);
				return threads(comments.filter((c) => c.id === root || c.in_reply_to_id === root));
			}
			const reviews = await list<Review>(`${pull}/reviews?per_page=100`);
			const conversation = await list<Review>(
				`/repos/${slug}/issues/${number}/comments?per_page=100`
			);
			return [...main(reviews), ...threads(comments), ...main(conversation)];
		},

		/** Open pull requests, newest first. */
		async listOpen(slug: string): Promise<PullRequestSummary[]> {
			const res = await request('GET', `/repos/${slug}/pulls?state=open&per_page=50`);
			if (res.status !== 200 || !Array.isArray(res.data)) {
				throw new EngineError(
					'github_failed',
					`GitHub couldn't list pull requests (${res.status}).`
				);
			}
			return (
				res.data as {
					number: number;
					title: string;
					html_url: string;
					user?: { login?: string };
					head: { ref: string };
					base: { ref: string };
					draft?: boolean;
				}[]
			).map((p) => ({
				number: p.number,
				title: p.title,
				url: p.html_url,
				author: p.user?.login ?? null,
				headRef: p.head.ref,
				baseRef: p.base.ref,
				draft: Boolean(p.draft)
			}));
		},

		/**
		 * A review (a comment, never an approval or a change request) with comments on lines,
		 * anchored to the commit reviewed. If GitHub refuses the line comments (say, the pull
		 * request changed under them), it's posted again with them in the main comment.
		 */
		async review(slug: string, number: number, input: ReviewInput): Promise<PostedReview> {
			const post = (comments: InlineComment[], notInline: InlineComment[]) =>
				request('POST', `/repos/${slug}/pulls/${number}/reviews`, {
					body: input.body(notInline),
					event: 'COMMENT',
					...(input.headSha ? { commit_id: input.headSha } : {}),
					comments: comments.map((c) => ({
						path: c.path,
						line: c.line,
						side: 'RIGHT',
						...(c.startLine < c.line ? { start_line: c.startLine, start_side: 'RIGHT' } : {}),
						body: c.body
					}))
				});
			let notInline: InlineComment[] = [];
			let res = await post(input.comments, notInline);
			if (res.status === 422 && input.comments.length > 0) {
				notInline = input.comments;
				res = await post([], notInline);
			}
			if (res.status !== 200 && res.status !== 201) {
				throw new EngineError(
					'github_failed',
					`GitHub refused the review (${res.status}): ${describe(res.data)}`
				);
			}
			return { url: String((res.data as { html_url?: string }).html_url ?? ''), notInline };
		},

		/** Post a review comment (not an approval or a change request). Returns its link. */
		async comment(slug: string, number: number, body: string): Promise<string> {
			const res = await request('POST', `/repos/${slug}/pulls/${number}/reviews`, {
				body,
				event: 'COMMENT'
			});
			if (res.status !== 200 && res.status !== 201) {
				throw new EngineError(
					'github_failed',
					`GitHub refused the review comment (${res.status}): ${describe(res.data)}`
				);
			}
			return String((res.data as { html_url?: string }).html_url ?? '');
		},

		/** A reply in the pull request's conversation (an issue comment). Returns its link. */
		async reply(slug: string, number: number, body: string): Promise<string> {
			const res = await request('POST', `/repos/${slug}/issues/${number}/comments`, { body });
			if (res.status !== 201 && res.status !== 200) {
				const hint =
					res.status === 403 || res.status === 404
						? ' The token may not have access to comment on this repository (it needs issues or pull requests write access).'
						: '';
				throw new EngineError(
					'github_failed',
					`GitHub refused the reply (${res.status}): ${describe(res.data) || 'unknown error'}.${hint}`
				);
			}
			return String((res.data as { html_url?: string }).html_url ?? '');
		}
	};
}
