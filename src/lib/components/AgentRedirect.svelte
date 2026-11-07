<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import type { AgentMode } from '#lib/agent-mode.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';

	/** Old workflow pages (New change, Review PR, Explore) now open the Agent in that mode. */
	let { mode }: { mode: AgentMode } = $props();

	onMount(() => {
		// The path is resolved; only the query is added.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${resolve(localizeHref('/agent') as Path)}?mode=${mode}`, { replaceState: true });
	});
</script>
