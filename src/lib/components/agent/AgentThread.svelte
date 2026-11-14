<script lang="ts">
	import Markdown from '#lib/components/shared/Markdown.svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import Wrench from '@lucide/svelte/icons/wrench';
	import type { Snippet } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import type { ThreadItem } from '#lib/components/agent/agent-thread.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		items,
		showRepos,
		working,
		report
	}: {
		items: ThreadItem[];
		showRepos: boolean;
		working: boolean;
		/** Renders a task's review or exploration inside the thread. */
		report?: Snippet<[string]>;
	} = $props();

	let container = $state<HTMLElement | null>(null);
	let stickToBottom = $state(true);

	// Notice when you scroll up to read, so new messages don't pull you back down.
	$effect(() => {
		const el = container;
		if (!el) return;
		const onScroll = () => {
			stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	// Follow new messages unless you scrolled up to read.
	$effect(() => {
		void items.length;
		void working;
		if (container && stickToBottom) container.scrollTop = container.scrollHeight;
	});

	const time = (iso: string) =>
		new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<ScrollArea
	bind:viewportRef={container}
	class="min-h-0 min-w-0 flex-1"
	data-testid="agent-thread-scroll"
>
	<div
		class="flex min-w-0 flex-col gap-3 py-2 pr-3 pl-1"
		role="log"
		aria-live="polite"
		data-testid="agent-thread"
	>
		<!-- Long URLs, paths and names wrap ([overflow-wrap:anywhere]) or are shortened, so the
	     thread never gets wider than its column. -->
		{#each items as item (item.key)}
			{#if item.kind === 'user'}
				<div class="flex min-w-0 flex-col items-end gap-1" data-kind="user">
					<div
						class="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-primary-foreground"
					>
						{item.text}
					</div>
					<span
						class="flex max-w-full flex-wrap items-center justify-end gap-1 text-xs text-muted-foreground"
					>
						{#if showRepos}
							{#each item.repos as repo (repo)}
								<Badge variant="outline" class="max-w-[12rem] truncate">{repo}</Badge>
							{/each}
						{/if}
						{time(item.at)}
					</span>
				</div>
			{:else if item.kind === 'assistant'}
				<div class="flex min-w-0 flex-col items-start gap-1" data-kind="assistant">
					<div class="max-w-[85%] min-w-0 rounded-2xl rounded-bl-sm bg-muted px-4 py-2">
						<Markdown text={item.text} streaming={working && item === items.at(-1)} />
					</div>
					<span class="flex max-w-full flex-wrap items-center gap-1 text-xs text-muted-foreground">
						{#if showRepos}
							{#each item.repos as repo (repo)}
								<Badge variant="outline" class="max-w-[12rem] truncate">{repo}</Badge>
							{/each}
						{/if}
						{time(item.at)}
					</span>
				</div>
			{:else if item.kind === 'note'}
				<div
					class="flex min-w-0 items-start gap-2 pl-2 text-xs text-muted-foreground"
					data-kind="note"
				>
					<MessageCircle class="mt-0.5 size-3 shrink-0" />
					<span class="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
						{#if showRepos && item.repos.length === 1}<span class="text-foreground/70"
								>{item.repos[0]}:</span
							>{/if}
						{item.text}
					</span>
				</div>
			{:else if item.kind === 'tool'}
				<div
					class="flex min-w-0 items-center gap-2 pl-2 font-mono text-xs text-muted-foreground"
					data-kind="tool"
				>
					<Wrench class="size-3 shrink-0" />
					{#if showRepos && item.repos.length === 1}
						<span class="max-w-[10rem] shrink-0 truncate text-foreground/70">{item.repos[0]}</span>
					{/if}
					<span class="min-w-0 truncate" title={item.text}>{item.text}</span>
				</div>
			{:else if item.kind === 'report'}
				<div class="flex min-w-0 flex-col items-start gap-1" data-kind="report">
					<div class="w-full min-w-0 rounded-2xl rounded-bl-sm border bg-card p-4">
						{#if showRepos}
							<Badge variant="outline" class="mb-3 max-w-[12rem] truncate">{item.repos[0]}</Badge>
						{/if}
						{#if report && item.taskId}{@render report(item.taskId)}{/if}
					</div>
				</div>
			{:else if item.kind === 'error'}
				<div class="flex min-w-0 items-start gap-2 pl-2 text-xs text-destructive" data-kind="error">
					<CircleAlert class="size-3.5 shrink-0" />
					<span class="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
						{#if showRepos}{item.repos[0]}:{/if}
						{item.text}
					</span>
				</div>
			{:else}
				<div
					class="min-w-0 pl-2 text-xs [overflow-wrap:anywhere] text-muted-foreground"
					data-kind="info"
				>
					{#if showRepos}<span class="text-foreground/70">{item.repos[0]}:</span>{/if}
					{item.text}
				</div>
			{/if}
		{/each}
		{#if working}
			<div class="flex items-center gap-2 pl-2 text-sm text-muted-foreground" role="status">
				<LoaderCircle class="size-4 animate-spin" />{m.agent_working()}
			</div>
		{/if}
	</div>
</ScrollArea>
