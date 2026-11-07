<script lang="ts">
	import EngineGate from '#lib/components/app/EngineGate.svelte';
	import PageHeader from '#lib/components/shared/PageHeader.svelte';
	import SettingsForm from '#lib/components/settings/SettingsForm.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<PageHeader title={m.settings_title()} description={m.settings_description()} />

<EngineGate>
	{#snippet children({ connection })}
		<SettingsForm client={connection.client} events={connection.events} />
	{/snippet}
</EngineGate>
