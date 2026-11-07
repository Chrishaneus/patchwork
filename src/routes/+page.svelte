<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import PageHeader from '#lib/components/shared/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import { appEngine } from '#lib/app/app-engine.svelte.js';

	// Load counts as soon as an engine is connected (on the server that happens after the first paint).
	$effect(() => {
		const { repositories, runs } = appEngine;
		if (repositories && !repositories.loaded) repositories.load();
		if (runs && !runs.loaded) runs.load();
	});

	const stats = $derived([
		{ label: m.stat_repositories, value: appEngine.repositories?.items.length ?? 0 },
		{ label: m.stat_active_runs, value: appEngine.runs?.activeCount ?? 0 },
		{ label: m.stat_open_prs, value: appEngine.runs?.openPullRequests ?? 0 }
	]);

	const steps = [
		{ title: m.step_add_repo_title, body: m.step_add_repo_body, path: '/repositories' },
		{ title: m.step_describe_title, body: m.step_describe_body, path: '/agent' },
		{ title: m.step_review_title, body: m.step_review_body, path: '/runs' }
	];
</script>

<PageHeader title={m.dashboard_title()} description={m.dashboard_description()} />

<div class="grid gap-4 sm:grid-cols-3">
	{#each stats as stat (stat.label)}
		<Card.Root>
			<Card.Header>
				<Card.Description>{stat.label()}</Card.Description>
				<Card.Title class="text-3xl tabular-nums">{stat.value}</Card.Title>
			</Card.Header>
		</Card.Root>
	{/each}
</div>

<Card.Root>
	<Card.Header>
		<Card.Title>{m.getting_started_title()}</Card.Title>
		<Card.Description>{m.getting_started_description()}</Card.Description>
	</Card.Header>
	<Card.Content>
		<ol class="grid gap-4 md:grid-cols-3">
			{#each steps as step, i (step.path)}
				<li class="flex flex-col gap-2 rounded-lg border p-4">
					<span class="text-xs font-medium text-muted-foreground">{i + 1}</span>
					<span class="font-medium">{step.title()}</span>
					<p class="flex-1 text-sm text-muted-foreground">{step.body()}</p>
					<Button
						variant="outline"
						size="sm"
						class="self-start"
						href={resolve(localizeHref(step.path) as Path)}>{step.title()}</Button
					>
				</li>
			{/each}
		</ol>
	</Card.Content>
</Card.Root>
