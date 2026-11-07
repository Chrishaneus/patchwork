<script lang="ts">
	import { onMount } from 'svelte';
	import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import type { InstructionTemplate } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	/** Pick a saved instruction, or save the current one as a template. */
	let { client, instruction = $bindable() }: { client: EngineClient; instruction: string } =
		$props();

	let templates = $state<InstructionTemplate[]>([]);
	let saving = $state(false);
	let name = $state('');
	let saved = $state(false);

	onMount(async () => {
		templates = await client.listTemplates({}).catch(() => []);
	});

	function choose(event: Event) {
		const id = (event.currentTarget as HTMLSelectElement).value;
		const template = templates.find((t) => t.id === id);
		if (template) instruction = template.instruction;
		(event.currentTarget as HTMLSelectElement).value = '';
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		await client.saveTemplate({ name, instruction });
		templates = await client.listTemplates({});
		saving = false;
		name = '';
		saved = true;
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	{#if templates.length > 0}
		<select
			class="h-8 rounded-md border bg-background px-2 text-sm"
			aria-label={m.templates_use()}
			onchange={choose}
		>
			<option value="">{m.templates_choose()}</option>
			{#each templates as template (template.id)}
				<option value={template.id}>{template.name}</option>
			{/each}
		</select>
	{/if}
	{#if saving}
		<form class="flex items-center gap-2" onsubmit={save}>
			<Input
				class="h-8 w-48"
				placeholder={m.templates_name()}
				aria-label={m.templates_name()}
				bind:value={name}
			/>
			<Button type="submit" size="sm" disabled={!name.trim()}>{m.templates_save_confirm()}</Button>
			<Button type="button" size="sm" variant="ghost" onclick={() => (saving = false)}
				>{m.repo_checks_cancel()}</Button
			>
		</form>
	{:else}
		<Button
			type="button"
			size="sm"
			variant="ghost"
			disabled={!instruction.trim()}
			onclick={() => {
				saving = true;
				saved = false;
			}}><BookmarkPlus />{m.templates_save()}</Button
		>
		{#if saved}<span class="text-sm text-muted-foreground" role="status">{m.templates_saved()}</span
			>{/if}
	{/if}
</div>
