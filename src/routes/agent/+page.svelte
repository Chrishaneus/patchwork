<script lang="ts">
	import { page } from '$app/state';
	import { parseAgentMode } from '#lib/agent-mode.js';
	import AgentRecent from '#lib/components/AgentRecent.svelte';
	import AgentStart from '#lib/components/AgentStart.svelte';
	import EngineGate from '#lib/components/EngineGate.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<PageHeader title={m.agent_title()} description={m.agent_description()} />

<EngineGate>
	{#snippet children({ repositories, runs, connection })}
		<div class="grid grid-cols-1 gap-6 xl:grid-cols-[14rem_minmax(0,1fr)]">
			<aside class="hidden min-w-0 xl:block"><AgentRecent {runs} /></aside>
			{#key page.url.searchParams.get('mode')}
				<AgentStart
					{repositories}
					{runs}
					client={connection.client}
					mode={parseAgentMode(page.url.searchParams.get('mode'))}
					pinned={page.url.searchParams.has('mode')}
				/>
			{/key}
		</div>
	{/snippet}
</EngineGate>
