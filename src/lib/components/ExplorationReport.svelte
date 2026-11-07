<script lang="ts">
	import Markdown from '#lib/components/Markdown.svelte';
	import Hammer from '@lucide/svelte/icons/hammer';
	import Lightbulb from '@lucide/svelte/icons/lightbulb';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type { Approach, Exploration } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		exploration,
		onBuild
	}: { exploration: Exploration; onBuild: (approach: Approach) => Promise<void> } = $props();

	let building = $state<string | null>(null);

	const efforts = {
		small: m.explore_effort_small,
		medium: m.explore_effort_medium,
		large: m.explore_effort_large
	};

	async function build(approach: Approach) {
		building = approach.title;
		try {
			await onBuild(approach);
		} finally {
			building = null;
		}
	}
</script>

<section class="mb-4 flex flex-col gap-4" data-testid="exploration-report">
	{#if exploration.recommendation}
		<Alert.Root>
			<Lightbulb />
			<Alert.Title>{m.explore_recommendation()}</Alert.Title>
			<Alert.Description><Markdown text={exploration.recommendation} /></Alert.Description>
		</Alert.Root>
	{/if}
	<div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
		{#each exploration.approaches as approach, i (i)}
			<Card.Root class="min-w-0" data-testid="approach">
				<Card.Header>
					<Card.Title class="leading-snug [overflow-wrap:anywhere]">{approach.title}</Card.Title>
					<Card.Description>{approach.summary}</Card.Description>
					<Card.Action>
						<Badge variant="outline">{efforts[approach.effort]()}</Badge>
					</Card.Action>
				</Card.Header>
				<Card.Content class="flex flex-1 flex-col gap-3 text-sm">
					{#if approach.details}
						<Markdown text={approach.details} />
					{/if}
					{#if approach.files.length > 0}
						<div>
							<p class="mb-1 text-xs font-medium text-muted-foreground">{m.explore_files()}</p>
							<ul class="flex flex-wrap gap-1">
								{#each approach.files as file (file)}
									<li>
										<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all"
											>{file}</code
										>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<p class="mb-1 text-xs font-medium text-muted-foreground">{m.explore_pros()}</p>
							<ul class="list-disc space-y-0.5 pl-4">
								{#each approach.pros as pro, j (j)}<li>{pro}</li>{/each}
							</ul>
						</div>
						<div>
							<p class="mb-1 text-xs font-medium text-muted-foreground">{m.explore_cons()}</p>
							<ul class="list-disc space-y-0.5 pl-4">
								{#each approach.cons as con, j (j)}<li>{con}</li>{/each}
							</ul>
						</div>
					</div>
				</Card.Content>
				<Card.Footer>
					<Button size="sm" disabled={building !== null} onclick={() => build(approach)}>
						<Hammer />{building === approach.title ? m.explore_building() : m.explore_build()}
					</Button>
				</Card.Footer>
			</Card.Root>
		{/each}
	</div>
</section>
