<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import EmptyState from '#lib/components/shared/EmptyState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { matchesFilter, matchesSearch, type RunFilter } from '#lib/components/runs/run-filter.js';
	import TaskStatusBadge from '#lib/components/runs/TaskStatusBadge.svelte';
	import * as Card from '#lib/components/ui/card/index.js';
	import { formatRelativeTime } from '#lib/components/shared/format.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let { runs }: { runs: RunsState } = $props();

	let search = $state('');
	let filter = $state<RunFilter>('all');

	const filters: { value: RunFilter; label: () => string }[] = [
		{ value: 'all', label: m.runs_filter_all },
		{ value: 'active', label: m.runs_filter_active },
		{ value: 'review', label: m.runs_filter_review },
		{ value: 'published', label: m.runs_filter_published },
		{ value: 'failed', label: m.runs_filter_failed }
	];

	const shown = $derived(
		runs.runs.filter((r) => matchesFilter(r, filter) && matchesSearch(r, search))
	);

	onMount(() => {
		runs.load();
	});
</script>

{#if runs.runs.length > 0}
	<div class="flex flex-col gap-3 md:flex-row md:items-center">
		<Input
			type="search"
			class="md:max-w-xs"
			placeholder={m.runs_search()}
			aria-label={m.runs_search()}
			bind:value={search}
		/>
		<div class="flex flex-wrap gap-1" role="group" aria-label={m.runs_title()}>
			{#each filters as f (f.value)}
				<Button
					variant={filter === f.value ? 'secondary' : 'ghost'}
					size="sm"
					aria-pressed={filter === f.value}
					onclick={() => (filter = f.value)}>{f.label()}</Button
				>
			{/each}
		</div>
		<Button
			variant="outline"
			size="sm"
			class="md:ml-auto"
			disabled={runs.syncing}
			onclick={() => runs.syncPullRequests()}
		>
			<RefreshCw class={runs.syncing ? 'animate-spin' : ''} />{runs.syncing
				? m.runs_syncing()
				: m.runs_sync()}
		</Button>
	</div>
{/if}

{#if runs.loaded && runs.runs.length === 0}
	<EmptyState message={m.runs_empty()} />
{:else if runs.loaded && shown.length === 0}
	<EmptyState message={m.runs_no_match()} />
{:else}
	<div class="grid gap-3">
		{#each shown as run (run.id)}
			<a href={resolve(localizeHref(`/runs/${run.id}`) as Path)} class="group" data-testid="run">
				<Card.Root class="transition-colors group-hover:bg-muted/40">
					<Card.Header>
						<Card.Title class="line-clamp-2 leading-snug">
							{#if run.kind === 'review'}
								<Badge variant="secondary" class="mr-1 align-middle">{m.run_kind_review()}</Badge>
							{:else if run.kind === 'ask'}
								<Badge variant="secondary" class="mr-1 align-middle">{m.run_kind_ask()}</Badge>
							{:else if run.kind === 'explore'}
								<Badge variant="secondary" class="mr-1 align-middle">{m.run_kind_explore()}</Badge>
							{/if}
							{run.instruction}
						</Card.Title>
						<Card.Description>
							{formatRelativeTime(run.createdAt)} · {m.runs_tasks_count({
								count: run.tasks.length
							})}
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex-row flex-wrap gap-2">
						{#each run.tasks as task (task.id)}
							<span class="flex items-center gap-1.5 text-sm">
								{task.repositoryName}
								<TaskStatusBadge status={task.status} kind={run.kind} />
								{#if task.pullRequest}
									{@const prState = task.pullRequest.state ?? 'open'}
									<Badge variant="outline" data-pr-state={prState}
										>{prState === 'merged'
											? m.pr_state_merged()
											: prState === 'closed'
												? m.pr_state_closed()
												: m.pr_state_open()}</Badge
									>
								{/if}
							</span>
						{/each}
					</Card.Content>
				</Card.Root>
			</a>
		{/each}
	</div>
{/if}
