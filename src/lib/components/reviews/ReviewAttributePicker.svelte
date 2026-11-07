<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { ReviewAttribute } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	/** Tick what a review rates (the defaults from Settings), and add your own for this review. */
	let {
		attributes = $bindable([]),
		chosen = $bindable([])
	}: { attributes?: ReviewAttribute[]; chosen?: string[] } = $props();

	let name = $state('');

	function toggle(id: string, on: boolean) {
		chosen = on ? [...chosen, id] : chosen.filter((c) => c !== id);
	}

	function add(event: Event) {
		event.preventDefault();
		const clean = name.trim();
		if (!clean) return;
		const id = `custom-${attributes.length}-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
		attributes = [...attributes, { id, name: clean, description: '' }];
		chosen = [...chosen, id];
		name = '';
	}
</script>

<div class="flex min-w-0 flex-col gap-3">
	<ul class="grid gap-2" data-testid="review-attributes">
		{#each attributes as attribute (attribute.id)}
			<li class="flex items-start gap-2">
				<Checkbox
					id={`attr-${attribute.id}`}
					checked={chosen.includes(attribute.id)}
					onCheckedChange={(on) => toggle(attribute.id, on === true)}
				/>
				<Label
					for={`attr-${attribute.id}`}
					class="min-w-0 font-normal"
					title={attribute.description}>{attribute.name}</Label
				>
			</li>
		{/each}
	</ul>
	<div class="flex gap-2">
		<Input
			class="h-8 min-w-0 flex-1"
			aria-label={m.review_custom_label()}
			placeholder={m.review_custom_name()}
			bind:value={name}
			onkeydown={(e) => e.key === 'Enter' && add(e)}
		/>
		<Button type="button" size="sm" variant="outline" disabled={!name.trim()} onclick={add}
			><Plus />{m.review_custom_add()}</Button
		>
	</div>
</div>
