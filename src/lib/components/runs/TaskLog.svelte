<script lang="ts">
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import type { LogEntry } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let { entries }: { entries: LogEntry[] } = $props();

	let container = $state<HTMLElement | null>(null);
	let stickToBottom = $state(true);

	$effect(() => {
		const el = container;
		if (!el) return;
		const onScroll = () => {
			stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	// Follow new lines unless the user scrolled up to read.
	$effect(() => {
		void entries.length;
		if (container && stickToBottom) container.scrollTop = container.scrollHeight;
	});

	const kindClass: Record<LogEntry['kind'], string> = {
		info: 'text-muted-foreground',
		assistant: 'text-foreground whitespace-pre-wrap',
		tool: 'font-mono text-xs text-muted-foreground',
		result: 'text-foreground whitespace-pre-wrap font-medium',
		error: 'text-destructive'
	};
	const time = (iso: string) => new Date(iso).toLocaleTimeString();
</script>

<ScrollArea
	bind:viewportRef={container}
	class="rounded-md border bg-muted/30 text-sm [&>[data-slot=scroll-area-viewport]]:max-h-96"
>
	<div class="p-3 pr-4" role="log" aria-live="polite" data-testid="task-log">
		{#if entries.length === 0}
			<p class="text-muted-foreground">{m.task_log_empty()}</p>
		{:else}
			<ol class="flex flex-col gap-1.5">
				{#each entries as entry, i (i)}
					<li class="flex gap-3">
						<time
							class="shrink-0 font-mono text-xs leading-5 text-muted-foreground/70"
							datetime={entry.at}>{time(entry.at)}</time
						>
						<span class={['min-w-0 [overflow-wrap:anywhere]', kindClass[entry.kind]]}
							>{entry.text}</span
						>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</ScrollArea>
