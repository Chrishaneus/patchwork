<script lang="ts">
	import KeyRound from '@lucide/svelte/icons/key-round';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { appEngine } from '#lib/app-engine.svelte.js';
	import { m } from '#lib/paraglide/messages.js';

	let token = $state('');
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		await appEngine.login(token);
		busy = false;
	}
</script>

<Card.Root class="max-w-md">
	<Card.Header>
		<Card.Title class="flex items-center gap-2"
			><KeyRound class="size-4" />{m.token_title()}</Card.Title
		>
		<Card.Description>{m.token_description()}</Card.Description>
	</Card.Header>
	<Card.Content>
		<form class="grid gap-3" onsubmit={submit}>
			<Label for="access-token">{m.token_label()}</Label>
			<Input id="access-token" type="password" autocomplete="current-password" bind:value={token} />
			{#if appEngine.tokenRejected}
				<p role="alert" class="text-sm text-destructive">{m.token_rejected()}</p>
			{/if}
			<Button type="submit" class="justify-self-start" disabled={busy || !token.trim()}
				>{m.token_submit()}</Button
			>
		</form>
	</Card.Content>
</Card.Root>
