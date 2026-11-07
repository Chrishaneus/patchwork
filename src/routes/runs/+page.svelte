<script lang="ts">
	import EngineGate from '#lib/components/EngineGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RunList from '#lib/components/RunList.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<PageHeader title={m.runs_title()} description={m.runs_description()} />

<EngineGate>
	{#snippet children({ runs })}
		<RunList {runs} />
	{/snippet}
</EngineGate>
