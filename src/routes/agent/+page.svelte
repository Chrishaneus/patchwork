<script lang="ts">
	import { page } from '$app/state';
	import { parseAgentMode } from '#lib/agent-mode.js';
	import AgentRecent from '#lib/components/AgentRecent.svelte';
	import AgentStart from '#lib/components/AgentStart.svelte';
	import EngineGate from '#lib/components/EngineGate.svelte';
	import { m } from '#lib/paraglide/messages.js';
</script>

<!-- No visible header: the start screen lines up with the conversation it turns into. -->
<h1 class="sr-only">{m.agent_title()}</h1>

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
