<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import type { PullRequest } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let { pullRequest }: { pullRequest: PullRequest } = $props();

	const prState = $derived(pullRequest.state ?? 'open');
	const label = $derived(
		pullRequest.provider === 'gitlab'
			? m.task_mr_link({ number: pullRequest.number })
			: m.task_pr_link({ number: pullRequest.number })
	);
	const stateLabel = $derived(
		prState === 'merged'
			? m.pr_state_merged()
			: prState === 'closed'
				? m.pr_state_closed()
				: m.pr_state_open()
	);
</script>

<span
	class="inline-flex flex-wrap items-center gap-2"
	data-testid="pull-request"
	data-pr-state={prState}
>
	<!-- External link to the pull request; not an app route. -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		href={pullRequest.url}
		target="_blank"
		rel="noreferrer"
		class="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
	>
		{label}<ExternalLink class="size-3.5" />
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
	<Badge
		variant={prState === 'closed' ? 'outline' : 'secondary'}
		class={prState === 'merged' ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : ''}
		>{stateLabel}</Badge
	>
	{#if pullRequest.draft && prState === 'open'}<span class="text-muted-foreground"
			>{m.task_pr_draft()}</span
		>{/if}
</span>
