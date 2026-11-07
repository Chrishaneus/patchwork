<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { m } from '#lib/paraglide/messages.js';

	/** A token setting (GitHub, GitLab): status, save and remove. The token is never shown again. */
	let {
		id,
		placeholder,
		tokenState,
		environmentLabel,
		onSave
	}: {
		id: string;
		placeholder: string;
		tokenState: { source: 'saved' | 'environment' | null; encrypted: boolean };
		environmentLabel: string;
		onSave: (token: string | null) => Promise<boolean>;
	} = $props();

	let token = $state('');
	let saved = $state(false);

	async function save(value: string | null) {
		saved = false;
		if (await onSave(value)) {
			token = '';
			saved = true;
		}
	}

	const status = $derived(
		tokenState.source === 'saved'
			? m.settings_github_status_saved()
			: tokenState.source === 'environment'
				? environmentLabel
				: m.settings_github_status_none()
	);
</script>

<form
	class="grid gap-3 sm:max-w-md"
	onsubmit={(e) => {
		e.preventDefault();
		save(token);
	}}
>
	<p class="text-sm" data-testid={`${id}-status`}>{status}</p>
	{#if tokenState.source === 'saved' && !tokenState.encrypted}
		<p class="text-xs text-muted-foreground">{m.settings_key_unencrypted()}</p>
	{/if}
	<div class="grid gap-2">
		<Label for={`${id}-token`}>{m.settings_github_label()}</Label>
		<Input id={`${id}-token`} type="password" autocomplete="off" {placeholder} bind:value={token} />
	</div>
	<div class="flex flex-wrap items-center gap-3">
		<Button type="submit" variant="outline" disabled={!token.trim()}
			>{m.settings_github_save()}</Button
		>
		{#if tokenState.source === 'saved'}
			<Button type="button" variant="ghost" onclick={() => save(null)}
				>{m.settings_github_remove()}</Button
			>
		{/if}
		{#if saved}<span class="text-sm text-muted-foreground" role="status">{m.settings_saved()}</span
			>{/if}
	</div>
</form>
