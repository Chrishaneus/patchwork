<script lang="ts">
	import { onMount } from 'svelte';
	import BulkPublishDialog from '#lib/components/runs/BulkPublishDialog.svelte';
	import EmptyState from '#lib/components/shared/EmptyState.svelte';
	import PageHeader from '#lib/components/shared/PageHeader.svelte';
	import TaskCard from '#lib/components/runs/TaskCard.svelte';
	import { formatRelativeTime } from '#lib/components/shared/format.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RepositoriesState } from '#lib/app/repositories.svelte.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let {
		runs,
		repositories,
		runId
	}: { runs: RunsState; repositories: RepositoriesState; runId: string } = $props();

	const run = $derived(runs.run(runId));

	onMount(() => {
		if (!runs.loaded) runs.load();
		if (!repositories.loaded) repositories.load();
	});
</script>

{#if run}
	{@const kind = run.kind ?? 'code'}
	<PageHeader
		title={kind === 'review'
			? (run.pullRequests?.length ?? 0) > 1
				? m.review_run_title_many({ count: run.pullRequests!.length })
				: m.review_run_title({ title: run.pullRequest?.title ?? run.instruction })
			: kind === 'explore'
				? m.explore_run_title({ idea: run.instruction })
				: run.instruction}
		description={formatRelativeTime(run.createdAt)}
	>
		{#snippet actions()}
			{#if run.tasks.length > 1 && kind === 'code'}<BulkPublishDialog {run} {runs} />{/if}
		{/snippet}
	</PageHeader>
	<div class="grid gap-4">
		{#each run.tasks as task (task.id)}
			<TaskCard
				{task}
				{runs}
				instruction={run.instruction}
				{kind}
				pullRequest={run.pullRequest}
				repository={repositories.items.find((r) => r.id === task.repositoryId)}
			/>
		{/each}
	</div>
{:else if runs.loaded}
	<EmptyState message={m.run_not_found()} />
{/if}
