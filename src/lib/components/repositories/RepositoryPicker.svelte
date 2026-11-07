<script lang="ts">
	import { flip } from 'svelte/animate';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RepositoryChoices } from '#lib/components/repositories/repository-choices.svelte.js';

	/** Pick repositories to run a change on: search, select shown, clear. */
	let {
		choices,
		selected = $bindable(),
		columns = 2,
		compact = false
	}: {
		choices: RepositoryChoices;
		selected: string[];
		columns?: 1 | 2;
		/** Narrow panel: stacked toolbar, single column, tighter rows. */
		compact?: boolean;
	} = $props();

	let search = $state('');

	const shown = $derived.by(() => {
		const query = search.trim().toLowerCase();
		const all = choices.available;
		const matching = query
			? all.filter((r) => [r.name, r.detail].some((field) => field.toLowerCase().includes(query)))
			: all;
		// Selected repositories first, in the order you picked them; the rest keep their order.
		const picked = selected
			.map((id) => matching.find((r) => r.id === id))
			.filter((r) => r !== undefined);
		return [...picked, ...matching.filter((r) => !selected.includes(r.id))];
	});

	// Preselect the repository when it's the only one, once: after that the choice is yours
	// (re-selecting whenever the selection is empty made it impossible to untick).
	let preselected = false;
	$effect(() => {
		if (preselected || !choices.loaded) return;
		preselected = true;
		const all = choices.available;
		if (all.length === 1 && selected.length === 0) selected = [all[0].id];
	});

	function toggle(id: string, checked: boolean) {
		selected = checked ? [...selected, id] : selected.filter((s) => s !== id);
	}
</script>

{#snippet list()}
	<fieldset class={['grid content-start gap-2', columns === 2 && !compact && 'sm:grid-cols-2']}>
		<legend class="sr-only">{m.new_change_repos_label()}</legend>
		{#each shown as repo (repo.id)}
			<div animate:flip={{ duration: 200 }} class="min-w-0">
				<Label
					class={[
						'flex items-start gap-3 rounded-md border font-normal has-data-[state=checked]:border-primary',
						compact ? 'p-2.5' : 'p-3'
					]}
				>
					<Checkbox
						checked={selected.includes(repo.id)}
						onCheckedChange={(checked) => toggle(repo.id, checked === true)}
					/>
					<span class="grid min-w-0 gap-0.5 [overflow-wrap:anywhere]">
						<span class="font-medium">{repo.name}</span>
						<span class="text-xs text-muted-foreground">
							{repo.detail}
							{#if repo.onFirstRun}· {m.new_change_on_first_run()}{/if}
						</span>
					</span>
				</Label>
			</div>
		{/each}
	</fieldset>
{/snippet}

<!-- Compact (side panel): search and buttons stay put; only the list scrolls. -->
<div class={compact ? 'flex min-h-0 flex-1 flex-col' : ''}>
	<div class={['mb-3 flex flex-col gap-2', !compact && 'sm:flex-row sm:flex-wrap sm:items-center']}>
		<Input
			type="search"
			class={compact ? '' : 'sm:max-w-xs'}
			placeholder={m.new_change_search()}
			aria-label={m.new_change_search()}
			bind:value={search}
		/>
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
			<Button
				type="button"
				variant="outline"
				size="sm"
				onclick={() => (selected = [...new Set([...selected, ...shown.map((r) => r.id)])])}
				>{m.new_change_select_shown()}</Button
			>
			<Button type="button" variant="ghost" size="sm" onclick={() => (selected = [])}
				>{m.new_change_clear()}</Button
			>
			<span class="text-sm whitespace-nowrap text-muted-foreground" data-testid="selected-count"
				>{m.new_change_selected({ count: selected.length })}</span
			>
		</div>
	</div>
	{#if compact}
		<!-- Side panel: only the list scrolls, with shadcn's scroll area. -->
		<ScrollArea class="min-h-0 flex-1" data-testid="repository-list">
			<div class="pr-3">{@render list()}</div>
		</ScrollArea>
	{:else}
		<div data-testid="repository-list">{@render list()}</div>
	{/if}
	{#if shown.length === 0}
		<p class="text-sm text-muted-foreground">{m.new_change_no_match()}</p>
	{/if}
</div>
