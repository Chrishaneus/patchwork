<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import LogIn from '@lucide/svelte/icons/log-in';
	import TokenField from '#lib/components/settings/TokenField.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import {
		EngineError,
		type EngineErrorCode,
		type EngineEventSource,
		type GitHubLoginStart,
		type Settings
	} from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		client,
		events,
		settings,
		onSettings,
		onSaveToken
	}: {
		client: EngineClient;
		events: EngineEventSource;
		settings: Settings;
		/** Called with fresh settings after sign-in, sign-out or a client ID change. */
		onSettings: (settings: Settings) => void;
		/** Save or remove the personal access token; resolves to whether it worked. */
		onSaveToken: (token: string | null) => Promise<boolean>;
	} = $props();

	let pending = $state<GitHubLoginStart | null>(null);
	let message = $state<string | null>(null);
	let error = $state<EngineErrorCode | null>(null);
	/** The engine's explanation (e.g. GitHub's reason), shown under the generic message. */
	let errorDetail = $state<string | null>(null);
	let clientId = $state('');

	// Sign-in finishes on GitHub; the engine tells us with a github.login event.
	$effect(() =>
		events(async (event) => {
			if (event.type !== 'github.login') return;
			pending = null;
			message =
				event.status === 'denied'
					? m.settings_github_denied()
					: event.status === 'expired'
						? (event.message ?? m.settings_github_expired())
						: event.status === 'failed'
							? m.settings_github_failed({ message: event.message ?? '' })
							: null;
			onSettings(await client.getSettings({}));
		})
	);

	async function attempt(action: () => Promise<void>) {
		error = null;
		errorDetail = null;
		message = null;
		try {
			await action();
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
			errorDetail = e instanceof Error ? e.message : null;
		}
	}

	// Fallback while waiting: if the engine restarted (or an event was missed), the sign-in that
	// was waiting is gone; say so instead of waiting forever.
	$effect(() => {
		if (!pending) return;
		const timer = setInterval(async () => {
			const status = await client.getGitHubLoginStatus({}).catch(() => null);
			if (!status || !pending) return;
			if (status.account) {
				pending = null;
				onSettings(await client.getSettings({}));
			} else if (!status.pending) {
				pending = null;
				message = m.settings_github_stopped();
			}
		}, 3000);
		return () => clearInterval(timer);
	});

	const signIn = () =>
		attempt(async () => {
			pending = await client.startGitHubLogin({});
		});
	const cancel = () =>
		attempt(async () => {
			await client.cancelGitHubLogin({});
			pending = null;
		});
	const signOut = () => attempt(async () => onSettings(await client.signOutGitHub({})));
	const saveClientId = (value: string | null) =>
		attempt(async () => {
			onSettings(await client.updateSettings({ githubClientId: value }));
			clientId = '';
		});
</script>

<Card.Root data-testid="github-signin">
	<Card.Header>
		<Card.Title>{m.settings_github_title()}</Card.Title>
		<Card.Description>{m.settings_github_card_description()}</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if settings.githubAccount}
			<div class="flex flex-wrap items-center gap-3">
				{#if settings.githubAccount.avatarUrl}
					<img src={settings.githubAccount.avatarUrl} alt="" class="size-8 rounded-full" />
				{/if}
				<span class="text-sm font-medium" data-testid="github-account"
					>{m.settings_github_signed_in({ login: settings.githubAccount.login })}</span
				>
				<Button variant="outline" size="sm" onclick={signOut}>{m.settings_github_signout()}</Button>
			</div>
		{:else if pending}
			<div class="flex flex-col gap-3 rounded-md border p-4" role="status">
				<p class="text-sm">{m.settings_github_code_intro()}</p>
				<p class="font-mono text-2xl font-semibold tracking-widest" data-testid="github-user-code">
					{pending.userCode}
				</p>
				<div class="flex flex-wrap items-center gap-2">
					<!-- External link to GitHub's device page; not an app route. -->
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<Button href={pending.verificationUri} target="_blank" rel="noreferrer" size="sm">
						{m.settings_github_open()}<ExternalLink />
					</Button>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<Button variant="ghost" size="sm" onclick={cancel}>{m.settings_github_cancel()}</Button>
				</div>
				<p class="text-sm text-muted-foreground">{m.settings_github_waiting()}</p>
			</div>
		{:else if settings.githubClientId.value}
			<Button class="self-start" onclick={signIn}><LogIn />{m.settings_github_signin()}</Button>
		{:else}
			<p class="text-sm text-muted-foreground">{m.settings_github_needs_client_id()}</p>
		{/if}

		{#if message}<p role="alert" class="text-sm text-destructive">{message}</p>{/if}
		{#if error}
			<div role="alert" class="text-sm text-destructive" data-testid="github-signin-error">
				<p>{engineErrorMessage(error)}</p>
				{#if errorDetail}<p class="text-muted-foreground">{errorDetail}</p>{/if}
			</div>
		{/if}

		<!-- Open by default when it matters: no client ID yet, or a token in use. -->
		<details
			class="group rounded-md border"
			open={!settings.githubAccount &&
				(!settings.githubClientId.value || settings.githubToken.source !== null)}
			data-testid="github-other"
		>
			<summary
				class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium select-none [&::-webkit-details-marker]:hidden"
			>
				<ChevronRight class="size-4 transition-transform group-open:rotate-90" />
				{m.settings_github_other()}
			</summary>
			<div class="grid gap-6 border-t px-4 py-4">
				<div class="grid gap-2">
					<h3 class="text-sm font-medium">{m.settings_github_pat_title()}</h3>
					<p class="text-xs text-muted-foreground">{m.settings_github_pat_description()}</p>
					<TokenField
						id="github"
						placeholder={m.settings_github_placeholder()}
						tokenState={settings.githubToken}
						environmentLabel={m.settings_github_status_environment()}
						onSave={onSaveToken}
					/>
				</div>
				<form
					class="grid gap-2 sm:max-w-md"
					onsubmit={(e) => {
						e.preventDefault();
						saveClientId(clientId);
					}}
				>
					<Label for="github-client-id">{m.settings_github_client_id()}</Label>
					{#if settings.githubClientId.value}
						<p class="font-mono text-xs" data-testid="github-client-id">
							{settings.githubClientId.value}
						</p>
					{/if}
					{#if settings.githubClientId.source === 'environment'}
						<p class="text-xs text-muted-foreground">{m.settings_github_client_id_env()}</p>
					{:else}
						<div class="flex gap-2">
							<Input
								id="github-client-id"
								class="font-mono"
								placeholder="Iv23li…"
								bind:value={clientId}
							/>
							<Button type="submit" variant="outline" disabled={!clientId.trim()}
								>{m.settings_github_client_id_save()}</Button
							>
						</div>
					{/if}
					<p class="text-xs text-muted-foreground">{m.settings_github_client_id_hint()}</p>
				</form>
			</div>
		</details>
	</Card.Content>
</Card.Root>
