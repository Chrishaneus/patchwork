<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { findModel, modelProviders, type ModelOption } from '#lib/models.js';
	import { m } from '#lib/paraglide/messages.js';

	/** Model picker: provider → models, older generations nested, or a custom model ID. */
	let { id, value = $bindable() }: { id: string; value: string } = $props();

	const current = $derived(findModel(value));
	let custom = $state(false);
</script>

{#snippet option(model: ModelOption)}
	<DropdownMenu.Item
		onSelect={() => {
			value = model.id;
			custom = false;
		}}
		data-model={model.id}
	>
		<Check class={value === model.id ? 'opacity-100' : 'opacity-0'} />
		<span class="grid">
			<span>{model.name}</span>
			<span class="text-xs text-muted-foreground">{model.note}</span>
		</span>
	</DropdownMenu.Item>
{/snippet}

<div class="grid gap-2">
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					{id}
					variant="outline"
					class="h-auto justify-between py-2 text-left font-normal"
				>
					<span class="grid">
						<span class="font-medium" data-testid="model-name">
							{current ? current.model.name : m.settings_model_custom()}
						</span>
						<span class="font-mono text-xs text-muted-foreground">
							{current ? `${current.provider.name} · ${value}` : value}
						</span>
					</span>
					<ChevronsUpDown class="opacity-60" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content class="w-72" align="start">
			{#each modelProviders as provider (provider.id)}
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>
						{#if current?.provider.id === provider.id}<Check />{:else}<span class="size-4"
							></span>{/if}
						{provider.name}
					</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent class="w-80">
						<DropdownMenu.Group>
							<DropdownMenu.GroupHeading>{m.settings_model_latest()}</DropdownMenu.GroupHeading>
							{#each provider.models as model (model.id)}
								{@render option(model)}
							{/each}
						</DropdownMenu.Group>
						{#if provider.older.length > 0}
							<DropdownMenu.Separator />
							<DropdownMenu.Sub>
								<DropdownMenu.SubTrigger
									><span class="size-4"></span>{m.settings_model_older()}</DropdownMenu.SubTrigger
								>
								<DropdownMenu.SubContent class="w-72">
									{#each provider.older as model (model.id)}
										{@render option(model)}
									{/each}
								</DropdownMenu.SubContent>
							</DropdownMenu.Sub>
						{/if}
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
			{/each}
			<DropdownMenu.Separator />
			<DropdownMenu.Item onSelect={() => (custom = true)}>
				<Pencil />{m.settings_model_custom_option()}
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	{#if custom || !current}
		<Input
			class="font-mono"
			aria-label={m.settings_model_custom_label()}
			placeholder="claude-…"
			bind:value
		/>
		<p class="text-xs text-muted-foreground">{m.settings_model_custom_hint()}</p>
	{/if}
</div>
