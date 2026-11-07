<script lang="ts">
	import Send from '@lucide/svelte/icons/send';
	import Wrench from '@lucide/svelte/icons/wrench';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { Task } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RunsState } from '#lib/runs.svelte.js';

	let { task, runs }: { task: Task; runs: RunsState } = $props();

	let instruction = $state('');
	let sending = $state(false);

	async function send(text: string) {
		sending = true;
		await runs.followUp(task.id, text);
		sending = false;
		if (!runs.actionErrors[task.id]) instruction = '';
	}
</script>

<form
	class="mt-4 flex flex-col gap-2 border-t pt-4"
	onsubmit={(e) => {
		e.preventDefault();
		send(instruction);
	}}
	data-testid="follow-up"
>
	<Label for={`follow-up-${task.id}`}>{m.followup_label()}</Label>
	{#if task.followUps?.length}
		<ol class="flex flex-col gap-1 text-sm text-muted-foreground" aria-label={m.followup_history()}>
			{#each task.followUps as followUp (followUp.at)}
				<li class="truncate">↳ {followUp.instruction}</li>
			{/each}
		</ol>
	{/if}
	<Textarea
		id={`follow-up-${task.id}`}
		rows={2}
		placeholder={m.followup_placeholder()}
		bind:value={instruction}
	/>
	<div class="flex flex-wrap items-center gap-2">
		<Button type="submit" size="sm" disabled={sending || !instruction.trim()}>
			<Send />{sending ? m.followup_sending() : m.followup_send()}
		</Button>
		{#if task.checks?.status === 'failed'}
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={sending}
				onclick={() => send(m.followup_fix_checks_instruction())}
			>
				<Wrench />{m.followup_fix_checks()}
			</Button>
		{/if}
		<span class="text-xs text-muted-foreground">{m.followup_hint()}</span>
	</div>
</form>
