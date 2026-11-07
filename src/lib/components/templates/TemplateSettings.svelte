<script lang="ts">
	import { onMount } from 'svelte';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import type { InstructionTemplate } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let { client }: { client: EngineClient } = $props();
	let templates = $state<InstructionTemplate[]>([]);

	onMount(async () => {
		templates = await client.listTemplates({});
	});

	async function remove(id: string) {
		await client.deleteTemplate({ id });
		templates = templates.filter((t) => t.id !== id);
	}
</script>

<Card.Root>
	<Card.Content>
		{#if templates.length === 0}
			<p class="text-sm text-muted-foreground">{m.templates_empty()}</p>
		{:else}
			<ul class="grid gap-2" data-testid="templates">
				{#each templates as template (template.id)}
					<li class="flex items-start gap-3 rounded-md border px-3 py-2">
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium">{template.name}</p>
							<p class="line-clamp-2 text-sm text-muted-foreground">{template.instruction}</p>
						</div>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`${m.templates_delete()} ${template.name}`}
							onclick={() => remove(template.id)}><Trash2 /></Button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</Card.Content>
</Card.Root>
