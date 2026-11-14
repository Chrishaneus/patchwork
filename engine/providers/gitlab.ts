import {
	EngineError,
	type PullRequest,
	type PullRequestState,
	type PullRequestSummary
} from '#lib/engine/contract.js';
import type { OpenPullRequestInput } from './github.js';
import type { InlineComment, PostedReview, ReviewInput } from './index.js';

interface GitLabMergeRequest {
	iid: number;
	web_url: string;
	state: 'opened' | 'closed' | 'merged' | 'locked';
	draft?: boolean;
	work_in_progress?: boolean;
}

const toPullRequest = (mr: GitLabMergeRequest): PullRequest => ({
	provider: 'gitlab',
	url: mr.web_url,
	number: mr.iid,
	draft: Boolean(mr.draft ?? mr.work_in_progress),
	state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
	syncedAt: new Date().toISOString()
});

/**
 * Minimal GitLab REST client for merge requests. `apiUrl` is https://gitlab.com/api/v4, a
 * self-hosted instance's /api/v4, or a test server. Projects are addressed by their path
 * (`group/subgroup/name`), URL-encoded, as GitLab allows.
 */
export function createGitLabClient(opts: { apiUrl: string; token: string }) {
	const request = async (method: string, path: string, body?: unknown) => {
		let res: Response;
		try {
			res = await fetch(`${opts.apiUrl.replace(/\/$/, '')}${path}`, {
				method,
				headers: {
					'private-token': opts.token,
					'user-agent': 'patchwork',
					...(body ? { 'content-type': 'application/json' } : {})
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(30_000)
			});
		} catch (error) {
			throw new EngineError('gitlab_failed', `Could not reach GitLab: ${(error as Error).message}`);
		}
		const data = (await res.json().catch(() => ({}))) as unknown;
		return { status: res.status, data };
	};

	const describe = (data: unknown) => {
		const message =
			(data as { message?: unknown; error?: unknown })?.message ??
			(data as { error?: unknown })?.error;
		return Array.isArray(message)
			? message.join('; ')
			: typeof message === 'string'
				? message
				: JSON.stringify(message ?? '');
	};

	const project = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

	return {
		async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
			const created = await request('POST', `${project(input.slug)}/merge_requests`, {
				source_branch: input.head,
				target_branch: input.base,
				// GitLab marks drafts by the title prefix.
				title: input.draft ? `Draft: ${input.title}` : input.title,
				description: input.body,
				remove_source_branch: true
			});
			if (created.status === 201) return toPullRequest(created.data as GitLabMergeRequest);

			// Publishing again after a partial failure: reuse the open merge request.
			if (created.status === 409) {
				const existing = await request(
					'GET',
					`${project(input.slug)}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.head)}`
				);
				const [mr] = (Array.isArray(existing.data) ? existing.data : []) as GitLabMergeRequest[];
				if (mr) return toPullRequest(mr);
			}

			const hint =
				created.status === 401
					? ' Check the GitLab token in Settings.'
					: created.status === 403 || created.status === 404
						? ' The token may not have access to this project (it needs the api scope).'
						: '';
			throw new EngineError(
				'gitlab_failed',
				`GitLab refused the merge request (${created.status}): ${describe(created.data) || 'unknown error'}.${hint}`
			);
		},

		async getState(slug: string, iid: number): Promise<PullRequestState> {
			const res = await request('GET', `${project(slug)}/merge_requests/${iid}`);
			if (res.status !== 200) {
				throw new EngineError(
					'gitlab_failed',
					`GitLab couldn't read merge request !${iid} (${res.status}): ${describe(res.data)}`
				);
			}
			return toPullRequest(res.data as GitLabMergeRequest).state;
		},

		async get(slug: string, iid: number) {
			const res = await request('GET', `${project(slug)}/merge_requests/${iid}`);
			if (res.status !== 200) {
				throw new EngineError(
					'invalid_pull_request',
					`GitLab couldn't find merge request !${iid} in ${slug} (${res.status}).`
				);
			}
			const mr = res.data as {
				title: string;
				web_url: string;
				target_branch: string;
				source_branch: string;
				sha?: string;
			};
			return {
				title: mr.title,
				url: mr.web_url,
				baseRef: mr.target_branch,
				headRef: mr.source_branch,
				headSha: mr.sha ?? null
			};
		},

		async listOpen(slug: string): Promise<PullRequestSummary[]> {
			const res = await request('GET', `${project(slug)}/merge_requests?state=opened&per_page=50`);
			if (res.status !== 200 || !Array.isArray(res.data)) {
				throw new EngineError(
					'gitlab_failed',
					`GitLab couldn't list merge requests (${res.status}).`
				);
			}
			return (
				res.data as {
					iid: number;
					title: string;
					web_url: string;
					author?: { username?: string };
					source_branch: string;
					target_branch: string;
					draft?: boolean;
				}[]
			).map((m) => ({
				number: m.iid,
				title: m.title,
				url: m.web_url,
				author: m.author?.username ?? null,
				headRef: m.source_branch,
				baseRef: m.target_branch,
				draft: Boolean(m.draft)
			}));
		},

		/**
		 * Comments on lines become discussions on the merge request's diff; the ones GitLab won't
		 * place go in the main note, posted last.
		 */
		async review(slug: string, iid: number, input: ReviewInput): Promise<PostedReview> {
			const mr = await request('GET', `${project(slug)}/merge_requests/${iid}`);
			const refs = (mr.data as { diff_refs?: Record<string, string> | null }).diff_refs;
			// The lines refer to the commit reviewed; if the merge request moved on, they may not fit.
			const placeable = !!refs && (!input.headSha || refs.head_sha === input.headSha);
			const notInline: InlineComment[] = [];
			for (const c of input.comments) {
				if (!placeable) {
					notInline.push(c);
					continue;
				}
				const res = await request('POST', `${project(slug)}/merge_requests/${iid}/discussions`, {
					body: c.body,
					position: {
						position_type: 'text',
						base_sha: refs!.base_sha,
						start_sha: refs!.start_sha,
						head_sha: refs!.head_sha,
						new_path: c.path,
						old_path: c.path,
						new_line: c.line
					}
				});
				if (res.status !== 200 && res.status !== 201) notInline.push(c);
			}
			return { url: await this.comment(slug, iid, input.body(notInline)), notInline };
		},

		async comment(slug: string, iid: number, body: string): Promise<string> {
			const res = await request('POST', `${project(slug)}/merge_requests/${iid}/notes`, { body });
			if (res.status !== 200 && res.status !== 201) {
				throw new EngineError(
					'gitlab_failed',
					`GitLab refused the comment (${res.status}): ${describe(res.data)}`
				);
			}
			const mr = await request('GET', `${project(slug)}/merge_requests/${iid}`);
			const base = String((mr.data as { web_url?: string }).web_url ?? '');
			const id = (res.data as { id?: number }).id;
			return id && base ? `${base}#note_${id}` : base;
		}
	};
}
