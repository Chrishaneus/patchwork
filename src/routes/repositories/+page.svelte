<script lang="ts">
	import EngineGate from '#lib/components/EngineGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RepositoryManager from '#lib/components/RepositoryManager.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<PageHeader title={m.repositories_title()} description={m.repositories_description()} />

<EngineGate>
	{#snippet children({ connection, repositories })}
		<RepositoryManager {repositories} {connection} />
	{/snippet}
</EngineGate>
