<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import GitPullRequestDraft from '@lucide/svelte/icons/git-pull-request-draft';
	import Lightbulb from '@lucide/svelte/icons/lightbulb';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import Plus from '@lucide/svelte/icons/plus';
	import { Button } from '#lib/components/ui/button/index.js';
	import { activeTaskStatuses } from '#lib/engine/contract.js';
	import { formatRelativeTime } from '#lib/components/shared/format.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let { runs, currentId }: { runs: RunsState; currentId?: string } = $props();
	const href = (path: string) => resolve(localizeHref(path) as Path);

	onMount(() => {
		if (!runs.loaded) runs.load();
	});
</script>

<nav class="flex flex-col gap-2" aria-label={m.agent_recent()}>
	<Button variant="outline" size="sm" href={href('/agent')} class="justify-start"
		><Plus />{m.agent_new()}</Button
	>
	<p class="mt-2 px-2 text-xs font-medium text-muted-foreground">{m.agent_recent()}</p>
	{#each runs.runs.slice(0, 30) as run (run.id)}
		{@const active = run.tasks.some((t) => activeTaskStatuses.includes(t.status))}
		<a
			href={href(`/agent/${run.id}`)}
			aria-current={run.id === currentId ? 'page' : undefined}
			class="flex min-w-0 flex-col rounded-md px-2 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted"
		>
			<span class="flex items-center gap-2">
				{#if active}<span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"
					></span>{/if}
				{#if run.kind === 'review'}
					<GitPullRequestDraft
						class="size-3.5 shrink-0 text-muted-foreground"
						aria-label={m.run_kind_review()}
					/>
				{:else if run.kind === 'ask'}
					<MessageCircleQuestion
						class="size-3.5 shrink-0 text-muted-foreground"
						aria-label={m.run_kind_ask()}
					/>
				{:else if run.kind === 'explore'}
					<Lightbulb
						class="size-3.5 shrink-0 text-muted-foreground"
						aria-label={m.run_kind_explore()}
					/>
				{/if}
				<span class="truncate">{run.pullRequest?.title ?? run.instruction}</span>
			</span>
			<span class="truncate text-xs text-muted-foreground"
				>{formatRelativeTime(run.createdAt)} · {run.tasks
					.map((t) => t.repositoryName)
					.join(', ')}</span
			>
		</a>
	{:else}
		<p class="px-2 text-sm text-muted-foreground">{m.agent_recent_empty()}</p>
	{/each}
</nav>
