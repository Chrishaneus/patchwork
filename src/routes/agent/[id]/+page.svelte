<script lang="ts">
	import { page } from '$app/state';
	import AgentChat from '#lib/components/AgentChat.svelte';
	import AgentRecent from '#lib/components/AgentRecent.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import EngineGate from '#lib/components/EngineGate.svelte';
	import { appEngine } from '#lib/app-engine.svelte.js';
	import { m } from '#lib/paraglide/messages.js';

	const id = $derived(page.params.id ?? '');

	$effect(() => {
		const runs = appEngine.runs;
		if (runs && !runs.loaded) runs.load();
	});
</script>

<EngineGate>
	{#snippet children({ runs, connection })}
		{@const run = runs.run(id)}
		<div class="grid grid-cols-1 gap-6 xl:grid-cols-[14rem_minmax(0,1fr)]">
			<aside class="hidden min-w-0 xl:block"><AgentRecent {runs} currentId={id} /></aside>
			{#if run}
				{#key run.id}<AgentChat {run} {runs} client={connection.client} />{/key}
			{:else if runs.loaded}
				<EmptyState message={m.run_not_found()} />
			{/if}
		</div>
	{/snippet}
</EngineGate>
