<script lang="ts">
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ApprovalAnswer, ApprovalRequest } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		approval,
		repository,
		onAnswer
	}: {
		approval: ApprovalRequest;
		/** Shown when the conversation has several repositories. */
		repository?: string;
		onAnswer: (answer: ApprovalAnswer) => Promise<unknown>;
	} = $props();

	let answering = $state(false);
	async function answer(value: ApprovalAnswer) {
		answering = true;
		try {
			await onAnswer(value);
		} finally {
			answering = false;
		}
	}
</script>

<section
	class="grid gap-3 rounded-xl border border-amber-500/50 bg-amber-500/5 p-4"
	aria-labelledby="approval-{approval.id}"
	data-testid="approval"
>
	<div class="flex flex-wrap items-center gap-2">
		<ShieldAlert class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
		<h2 id="approval-{approval.id}" class="text-sm font-medium">{m.approval_title()}</h2>
		{#if repository}<Badge variant="outline" class="max-w-[12rem] truncate">{repository}</Badge
			>{/if}
	</div>
	<pre
		class="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{approval.command}</pre>
	{#if approval.reason}
		<p class="text-sm text-muted-foreground">{m.approval_reason({ reason: approval.reason })}</p>
	{/if}
	<p class="text-xs text-muted-foreground">{m.approval_warning()}</p>
	<div class="flex flex-wrap items-center gap-2">
		<Button size="sm" disabled={answering} onclick={() => answer('once')}
			>{m.approval_allow_once()}</Button
		>
		{#if approval.program}
			<Button size="sm" variant="outline" disabled={answering} onclick={() => answer('always')}
				>{m.approval_allow_always({ program: approval.program })}</Button
			>
		{/if}
		<Button size="sm" variant="ghost" disabled={answering} onclick={() => answer('deny')}
			>{m.approval_deny()}</Button
		>
	</div>
	{#if !approval.program}
		<p class="text-xs text-muted-foreground">{m.approval_once_only()}</p>
	{/if}
</section>
