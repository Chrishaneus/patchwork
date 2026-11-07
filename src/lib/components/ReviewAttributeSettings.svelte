<script lang="ts">
	import { onMount } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import { EngineError, type EngineErrorCode, type ReviewAttribute } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';

	let { client }: { client: EngineClient } = $props();

	let attributes = $state<ReviewAttribute[]>([]);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<EngineErrorCode | null>(null);

	onMount(async () => {
		attributes = (await client.getSettings({})).reviewAttributes.map((a) => ({ ...a }));
	});

	function add() {
		attributes = [...attributes, { id: '', name: '', description: '' }];
		saved = false;
	}

	function remove(index: number) {
		attributes = attributes.filter((_, i) => i !== index);
		saved = false;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		saved = false;
		error = null;
		try {
			const settings = await client.updateSettings({
				reviewAttributes: attributes.filter((a) => a.name.trim())
			});
			attributes = settings.reviewAttributes.map((a) => ({ ...a }));
			saved = true;
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
		} finally {
			saving = false;
		}
	}
</script>

<Card.Root>
	<Card.Content>
		<form class="flex flex-col gap-4" onsubmit={save}>
			<ul class="grid gap-3" data-testid="review-attribute-settings">
				{#each attributes as attribute, i (i)}
					<li class="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start">
						<Input
							class="sm:w-48"
							aria-label={m.settings_attribute_name()}
							placeholder={m.settings_attribute_name()}
							bind:value={attribute.name}
							oninput={() => (saved = false)}
						/>
						<Input
							class="min-w-0 flex-1"
							aria-label={m.settings_attribute_description()}
							placeholder={m.settings_attribute_description()}
							bind:value={attribute.description}
							oninput={() => (saved = false)}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="self-end sm:self-auto"
							aria-label={`${m.settings_attribute_remove()} ${attribute.name}`}
							onclick={() => remove(i)}><Trash2 /></Button
						>
					</li>
				{/each}
			</ul>
			<div class="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" onclick={add}>
					<Plus />{m.settings_attribute_add()}
				</Button>
				<Button type="submit" disabled={saving}>{m.settings_attribute_save()}</Button>
				{#if saved}<span class="text-sm text-muted-foreground" role="status"
						>{m.settings_saved()}</span
					>{/if}
			</div>
			{#if error}
				<p role="alert" class="text-sm text-destructive">{engineErrorMessage(error)}</p>
			{/if}
		</form>
	</Card.Content>
</Card.Root>
