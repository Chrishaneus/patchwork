<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { Snippet } from 'svelte';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';

	/**
	 * A side panel that's always open on large screens, and collapses to a one-line summary on
	 * small ones (tap to open), so a long list doesn't push the main content down.
	 */
	let {
		title,
		summary,
		testid,
		class: className = '',
		scroll = false,
		children
	}: {
		title: string;
		/** Shown next to the title when collapsed, e.g. "2 selected". */
		summary: string;
		testid?: string;
		class?: string;
		/** On small screens, scroll the open panel (when its content doesn't scroll itself). */
		scroll?: boolean;
		children: Snippet;
	} = $props();

	let open = $state(false);
</script>

<aside
	class={['min-w-0 rounded-lg border bg-card', className]}
	aria-label={title}
	data-testid={testid}
>
	<button
		type="button"
		class="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm lg:hidden"
		aria-expanded={open}
		onclick={() => (open = !open)}
		data-testid={testid ? `${testid}-toggle` : undefined}
	>
		<span class="min-w-0 truncate"
			><span class="font-medium">{title}</span>
			<span class="text-muted-foreground">· {summary}</span></span
		>
		<ChevronDown class={['size-4 shrink-0 transition-transform', open && 'rotate-180']} />
	</button>
	<div
		class={[
			'min-h-0 flex-col lg:flex',
			open ? 'flex max-h-[50svh] border-t lg:max-h-none lg:border-t-0' : 'hidden'
		]}
	>
		{#if scroll}
			<ScrollArea
				class="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:max-h-[50svh] lg:[&>[data-slot=scroll-area-viewport]]:max-h-none"
			>
				{@render children()}
			</ScrollArea>
		{:else}
			{@render children()}
		{/if}
	</div>
</aside>
