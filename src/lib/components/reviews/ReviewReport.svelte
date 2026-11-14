<script lang="ts">
	import Markdown from '#lib/components/shared/Markdown.svelte';
	import ReviewSuggestion from '#lib/components/reviews/ReviewSuggestion.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Star from '@lucide/svelte/icons/star';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type {
		ReviewComment,
		ReviewedPullRequest,
		ReviewResult,
		ReviewScore,
		ReviewVerdict
	} from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	/**
	 * A finished review: scores, summary and suggested changes. When several pull requests were
	 * reviewed together, the set as a whole first, then each pull request with its own.
	 */
	let {
		review,
		pullRequest,
		onPost
	}: {
		review: ReviewResult;
		/** The pull request reviewed (the first, for a set); none hides posting. */
		pullRequest?: ReviewedPullRequest;
		/** Post one pull request's review (by link), or every one not posted yet. */
		onPost: (url?: string) => Promise<void>;
	} = $props();

	/** Which posts are under way: a link, or '*' for all. */
	let posting = $state<string | null>(null);

	const verdicts: Record<ReviewVerdict, () => string> = {
		approve: m.review_verdict_approve,
		comment: m.review_verdict_comment,
		request_changes: m.review_verdict_request_changes
	};
	const average = (scores: ReviewScore[]) =>
		scores.length ? (scores.reduce((sum, s) => sum + s.score, 0) / scores.length).toFixed(1) : '0';
	const set = $derived(review.pullRequests ?? null);
	const unposted = $derived(set?.filter((p) => !p.postedUrl).length ?? 0);

	async function post(key: string, url?: string) {
		posting = key;
		try {
			await onPost(url);
		} finally {
			posting = null;
		}
	}
</script>

{#snippet verdict(value: ReviewVerdict, scores: ReviewScore[])}
	<Badge
		variant={value === 'request_changes'
			? 'destructive'
			: value === 'approve'
				? 'default'
				: 'secondary'}
		data-verdict={value}>{verdicts[value]()}</Badge
	>
	<span class="text-sm text-muted-foreground">{m.review_average({ score: average(scores) })}</span>
{/snippet}

{#snippet postButton(
	provider: 'github' | 'gitlab',
	postedUrl: string | null,
	key: string,
	url?: string
)}
	{#if postedUrl}
		<Button variant="outline" size="sm" href={postedUrl} target="_blank" rel="noreferrer">
			<ExternalLink />{m.review_posted()}
		</Button>
	{:else}
		<Button size="sm" disabled={posting !== null} onclick={() => post(key, url)}>
			<MessageSquarePlus />{posting === key || posting === '*'
				? m.review_posting()
				: provider === 'gitlab'
					? m.review_post_gitlab()
					: m.review_post_github()}
		</Button>
	{/if}
{/snippet}

{#snippet scoreList(scores: ReviewScore[])}
	<ul class="grid gap-3">
		{#each scores as score (score.attribute)}
			<li class="rounded-md border p-3" data-testid="review-score">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{score.attribute}</span>
					<span
						class="flex items-center gap-0.5"
						role="img"
						aria-label={m.review_score_label({ score: score.score })}
					>
						{#each [1, 2, 3, 4, 5] as n (n)}
							<Star
								class={n <= score.score
									? 'size-4 fill-amber-400 text-amber-400'
									: 'size-4 text-muted-foreground/40'}
							/>
						{/each}
					</span>
					<span class="text-sm text-muted-foreground">{score.score}/5</span>
				</div>
				<Markdown text={score.explanation} class="mt-1 text-muted-foreground" />
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet suggestions(comments: ReviewComment[] | undefined)}
	{#if comments?.length}
		<div class="flex flex-col gap-2" data-testid="review-suggestions">
			<h3 class="text-sm font-medium">
				{m.review_suggestions({ count: comments.length })}
			</h3>
			<ul class="flex flex-col gap-2">
				{#each comments as comment, i (i)}
					<ReviewSuggestion {comment} />
				{/each}
			</ul>
		</div>
	{/if}
{/snippet}

<section class="mb-4 flex flex-col gap-4" data-testid="review-report">
	{#if set}
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-sm font-medium" data-testid="review-set"
				>{m.review_set_title({ count: set.length })}</span
			>
			{@render verdict(review.verdict, review.scores)}
			{#if pullRequest && unposted > 0}
				<div class="ml-auto">
					<Button size="sm" disabled={posting !== null} onclick={() => post('*')}>
						<MessageSquarePlus />{posting === '*' ? m.review_posting() : m.review_post_all()}
					</Button>
				</div>
			{/if}
		</div>
		{#if review.summary}
			<Markdown text={review.summary} />
		{/if}
		<details class="rounded-md border" data-testid="review-set-scores">
			<summary class="cursor-pointer px-3 py-2 text-sm font-medium">{m.review_set_scores()}</summary
			>
			<div class="p-3 pt-0">{@render scoreList(review.scores)}</div>
		</details>

		{#each set as pr (pr.url)}
			<Card.Root data-testid="review-pull-request" data-url={pr.url}>
				<Card.Header>
					<Card.Title class="text-base">
						<!-- An external page (GitHub or GitLab), not one of the app's routes. -->
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a href={pr.url} target="_blank" rel="noreferrer" class="hover:underline"
							>#{pr.number} {pr.title}</a
						>
					</Card.Title>
					<Card.Description class="font-mono text-xs [overflow-wrap:anywhere]"
						>{pr.url}</Card.Description
					>
					{#if pullRequest}
						<Card.Action>
							{@render postButton(pr.provider, pr.postedUrl, pr.url, pr.url)}
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content class="flex flex-col gap-4">
					<div class="flex flex-wrap items-center gap-2">
						{@render verdict(pr.verdict, pr.scores)}
					</div>
					{#if pr.summary}
						<Markdown text={pr.summary} />
					{/if}
					{@render scoreList(pr.scores)}
					{@render suggestions(pr.comments)}
				</Card.Content>
			</Card.Root>
		{/each}
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			{@render verdict(review.verdict, review.scores)}
			{#if pullRequest}
				<div class="ml-auto flex items-center gap-2">
					{@render postButton(pullRequest.provider, review.postedUrl, 'one')}
				</div>
			{/if}
		</div>
		{#if review.summary}
			<Markdown text={review.summary} />
		{/if}
		{@render scoreList(review.scores)}
		{@render suggestions(review.comments)}
	{/if}
</section>
