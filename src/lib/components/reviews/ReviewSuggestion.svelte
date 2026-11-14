<script lang="ts">
	import Markdown from '#lib/components/shared/Markdown.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import type { ReviewComment } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	/** One inline comment: where, why, and the suggested change as a small diff. */
	let { comment }: { comment: ReviewComment } = $props();

	const where = $derived(
		comment.startLine === comment.line
			? m.review_comment_line({ line: comment.line })
			: m.review_comment_lines({ start: comment.startLine, end: comment.line })
	);
	// The lines as they are (removed), then the suggestion (added). A suggestion of nothing
	// deletes them.
	const removed = $derived(
		comment.suggestion !== null && comment.original !== null ? comment.original.split('\n') : []
	);
	const added = $derived(comment.suggestion ? comment.suggestion.split('\n') : []);
</script>

<li class="overflow-hidden rounded-md border" data-testid="review-comment" data-path={comment.path}>
	<div class="flex flex-wrap items-center gap-2 bg-muted/50 px-3 py-2">
		<span class="font-mono text-xs [overflow-wrap:anywhere]">{comment.path}</span>
		<span class="text-xs text-muted-foreground">{where}</span>
		{#if !comment.inDiff}
			<Tooltip.Provider>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Badge {...props} variant="outline" class="ml-auto" data-testid="not-in-diff"
								>{m.review_not_in_diff()}</Badge
							>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-xs">{m.review_not_in_diff_hint()}</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		{/if}
	</div>
	{#if comment.body}
		<Markdown text={comment.body} class="px-3 py-2 text-sm" />
	{/if}
	{#if comment.suggestion !== null}
		<pre
			class="overflow-x-auto border-t py-1 font-mono text-xs leading-5"
			aria-label={m.review_suggested_change()}><code
				>{#each removed as line, i (`-${i}`)}<span
						class="block bg-red-500/10 px-3 text-red-800 dark:text-red-300">- {line}</span
					>{/each}{#each added as line, i (`+${i}`)}<span
						class="block bg-green-500/10 px-3 text-green-800 dark:text-green-300">+ {line}</span
					>{/each}{#if added.length === 0}<span class="block px-3 text-muted-foreground"
						>{m.review_suggestion_delete()}</span
					>{/if}</code
			></pre>
	{/if}
</li>
