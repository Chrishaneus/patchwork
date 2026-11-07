<script lang="ts">
	import Markdown from '#lib/components/Markdown.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Star from '@lucide/svelte/icons/star';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ReviewedPullRequest, ReviewResult } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		review,
		pullRequest,
		onPost
	}: {
		review: ReviewResult;
		pullRequest?: ReviewedPullRequest;
		onPost: () => Promise<void>;
	} = $props();

	let posting = $state(false);

	const verdicts = {
		approve: m.review_verdict_approve,
		comment: m.review_verdict_comment,
		request_changes: m.review_verdict_request_changes
	};
	const average = $derived(
		review.scores.length
			? review.scores.reduce((sum, s) => sum + s.score, 0) / review.scores.length
			: 0
	);

	async function post() {
		posting = true;
		try {
			await onPost();
		} finally {
			posting = false;
		}
	}
</script>

<section class="mb-4 flex flex-col gap-4" data-testid="review-report">
	<div class="flex flex-wrap items-center gap-2">
		<Badge
			variant={review.verdict === 'request_changes'
				? 'destructive'
				: review.verdict === 'approve'
					? 'default'
					: 'secondary'}
			data-verdict={review.verdict}>{verdicts[review.verdict]()}</Badge
		>
		<span class="text-sm text-muted-foreground"
			>{m.review_average({ score: average.toFixed(1) })}</span
		>
		<div class="ml-auto flex items-center gap-2">
			{#if review.postedUrl}
				<Button
					variant="outline"
					size="sm"
					href={review.postedUrl}
					target="_blank"
					rel="noreferrer"
				>
					<ExternalLink />{m.review_posted()}
				</Button>
			{:else if pullRequest}
				<Button size="sm" disabled={posting} onclick={post}>
					<MessageSquarePlus />{posting
						? m.review_posting()
						: pullRequest.provider === 'gitlab'
							? m.review_post_gitlab()
							: m.review_post_github()}
				</Button>
			{/if}
		</div>
	</div>

	{#if review.summary}
		<Markdown text={review.summary} />
	{/if}

	<ul class="grid gap-3">
		{#each review.scores as score (score.attribute)}
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
</section>
