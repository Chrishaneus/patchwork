<script lang="ts">
	import Send from '@lucide/svelte/icons/send';
	import Square from '@lucide/svelte/icons/square';
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { m } from '#lib/paraglide/messages.js';

	/** The message box: Enter sends, Shift+Enter adds a line; Stop while the agent works. */
	let {
		placeholder,
		label,
		disabled = false,
		busy = false,
		onSend,
		onStop,
		text = $bindable(''),
		allowEmpty = false,
		toolbar
	}: {
		placeholder: string;
		/** The box's accessible name, when the placeholder changes as you type. */
		label?: string;
		disabled?: boolean;
		busy?: boolean;
		onSend: (text: string) => Promise<boolean>;
		onStop?: () => void;
		/** The message being written. */
		text?: string;
		/** Whether Send works with an empty message (e.g. a review picked in the side panel). */
		allowEmpty?: boolean;
		/** Controls shown above the message box (mode switch, templates). */
		toolbar?: Snippet;
	} = $props();

	let sending = $state(false);

	async function send() {
		if ((!text.trim() && !allowEmpty) || disabled || busy || sending) return;
		sending = true;
		if (await onSend(text.trim())) text = '';
		sending = false;
	}
</script>

<form
	class="flex flex-col gap-2 rounded-lg border bg-card p-3"
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
	data-testid="agent-composer"
>
	{#if toolbar}{@render toolbar()}{/if}
	<Textarea
		rows={2}
		class="max-h-48 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
		{placeholder}
		aria-label={label ?? placeholder}
		disabled={disabled || sending}
		bind:value={text}
		onkeydown={(e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				send();
			}
		}}
	/>
	<div class="flex items-center justify-between gap-2">
		<span class="text-xs text-muted-foreground">{m.agent_enter_hint()}</span>
		{#if busy && onStop}
			<Button type="button" size="sm" variant="outline" onclick={onStop}
				><Square />{m.agent_stop()}</Button
			>
		{:else}
			<Button
				type="submit"
				size="sm"
				disabled={disabled || sending || (!text.trim() && !allowEmpty)}
				><Send />{m.agent_send()}</Button
			>
		{/if}
	</div>
</form>
