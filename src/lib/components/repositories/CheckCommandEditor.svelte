<script lang="ts">
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { EngineErrorCode } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		repoId,
		command,
		onSave
	}: {
		repoId: string;
		command: string | null;
		onSave: (command: string | null) => Promise<EngineErrorCode | null>;
	} = $props();

	let editing = $state(false);
	let value = $state('');
	let saving = $state(false);
	let error = $state<EngineErrorCode | null>(null);

	function start() {
		value = command ?? '';
		error = null;
		editing = true;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = await onSave(value.trim() || null);
		saving = false;
		if (!error) editing = false;
	}
</script>

{#if editing}
	<form class="flex w-full flex-col gap-2" onsubmit={save}>
		<Label for={`checks-${repoId}`}>{m.repo_checks_label()}</Label>
		<div class="flex flex-col gap-2 sm:flex-row">
			<Input
				id={`checks-${repoId}`}
				class="font-mono"
				placeholder={m.repo_checks_placeholder()}
				autocomplete="off"
				spellcheck={false}
				bind:value
			/>
			<div class="flex gap-2">
				<Button type="submit" size="sm" disabled={saving}>{m.repo_checks_save()}</Button>
				<Button type="button" size="sm" variant="ghost" onclick={() => (editing = false)}
					>{m.repo_checks_cancel()}</Button
				>
			</div>
		</div>
		<p class="text-xs text-muted-foreground">{m.repo_checks_hint()}</p>
		{#if error}<p role="alert" class="text-sm text-destructive">{engineErrorMessage(error)}</p>{/if}
	</form>
{:else}
	<div class="flex w-full items-center gap-2 text-sm">
		<ListChecks class="size-4 text-muted-foreground" />
		{#if command}
			<code
				class="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
				data-testid="check-command">{command}</code
			>
		{:else}
			<span class="text-muted-foreground">{m.repo_checks_none()}</span>
		{/if}
		<Button variant="ghost" size="sm" onclick={start}><Pencil />{m.repo_checks_edit()}</Button>
	</div>
{/if}
