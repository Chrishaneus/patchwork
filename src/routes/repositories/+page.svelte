<script lang="ts">
	import EngineGate from '#lib/components/app/EngineGate.svelte';
	import PageHeader from '#lib/components/shared/PageHeader.svelte';
	import RepositoryManager from '#lib/components/repositories/RepositoryManager.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<PageHeader title={m.repositories_title()} description={m.repositories_description()} />

<EngineGate>
	{#snippet children({ connection, repositories })}
		<RepositoryManager {repositories} {connection} />
	{/snippet}
</EngineGate>
