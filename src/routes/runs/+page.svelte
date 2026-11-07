<script lang="ts">
	import EngineGate from '#lib/components/app/EngineGate.svelte';
	import PageHeader from '#lib/components/shared/PageHeader.svelte';
	import RunList from '#lib/components/runs/RunList.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<PageHeader title={m.runs_title()} description={m.runs_description()} />

<EngineGate>
	{#snippet children({ runs })}
		<RunList {runs} />
	{/snippet}
</EngineGate>
