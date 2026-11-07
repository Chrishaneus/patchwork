<script lang="ts">
	import type { Snippet } from 'svelte';
	import AccessTokenForm from '#lib/components/AccessTokenForm.svelte';
	import EngineUnavailableNotice from '#lib/components/EngineUnavailableNotice.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { appEngine } from '#lib/app-engine.svelte.js';
	import type { EngineConnection } from '#lib/engine/client.js';
	import type { RepositoriesState } from '#lib/repositories.svelte.js';
	import type { RunsState } from '#lib/runs.svelte.js';

	/** Renders its content only once an engine is connected, with the connected state as arguments. */
	let {
		children
	}: {
		children: Snippet<
			[{ connection: EngineConnection; repositories: RepositoriesState; runs: RunsState }]
		>;
	} = $props();
</script>

{#if appEngine.status === 'ready' && appEngine.connection && appEngine.repositories && appEngine.runs}
	{@render children({
		connection: appEngine.connection,
		repositories: appEngine.repositories,
		runs: appEngine.runs
	})}
{:else if appEngine.status === 'connecting'}
	<div class="grid gap-4" aria-busy="true">
		<Skeleton class="h-32 w-full" />
		<Skeleton class="h-24 w-full" />
	</div>
{:else if appEngine.status === 'unauthorized'}
	<AccessTokenForm />
{:else}
	<EngineUnavailableNotice />
{/if}
