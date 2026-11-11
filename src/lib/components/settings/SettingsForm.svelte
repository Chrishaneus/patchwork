<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import { onMount } from 'svelte';
	import GitHubSignIn from '#lib/components/settings/GitHubSignIn.svelte';
	import TemplateSettings from '#lib/components/templates/TemplateSettings.svelte';
	import ReviewAttributeSettings from '#lib/components/reviews/ReviewAttributeSettings.svelte';
	import ModelPicker from '#lib/components/settings/ModelPicker.svelte';
	import SettingsSection from '#lib/components/settings/SettingsSection.svelte';
	import TokenField from '#lib/components/settings/TokenField.svelte';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import {
		EngineError,
		type EngineErrorCode,
		type EngineEventSource,
		type Settings
	} from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { findModel, modelProviders, providerOf } from '#lib/engine/models.js';
	import { m } from '#lib/paraglide/messages.js';

	let { client, events }: { client: EngineClient; events: EngineEventSource } = $props();

	let settings = $state<Settings | null>(null);
	let model = $state('');
	let timeoutMinutes = $state(30);
	let concurrency = $state(2);
	/** Auto mode's model, or RULES_ONLY (the Select needs a string). */
	let autoMode = $state('');
	const RULES_ONLY = 'rules';
	let apiKey = $state('');
	let saved = $state<'ai' | 'key' | null>(null);
	let error = $state<EngineErrorCode | null>(null);

	onMount(async () => {
		apply(await client.getSettings({}));
	});

	function apply(next: Settings) {
		settings = next;
		model = next.model;
		timeoutMinutes = next.timeoutMinutes;
		concurrency = next.concurrency;
		autoMode = next.autoModeModel ?? RULES_ONLY;
	}

	/** Current Claude models, plus the saved one if it's older or custom. */
	const autoModeModels = $derived.by(() => {
		const current = modelProviders.find((p) => p.id === 'anthropic')?.models ?? [];
		const saved = settings?.autoModeModel;
		return saved && !current.some((model) => model.id === saved)
			? [...current, { id: saved, name: findModel(saved)?.model.name ?? saved }]
			: current;
	});
	const autoModeName = $derived(
		autoMode === RULES_ONLY
			? m.settings_auto_mode_rules()
			: (autoModeModels.find((model) => model.id === autoMode)?.name ?? autoMode)
	);

	async function save(
		section: 'ai' | 'key',
		update: Parameters<EngineClient['updateSettings']>[0]
	) {
		error = null;
		saved = null;
		try {
			apply(await client.updateSettings(update));
			saved = section;
			apiKey = '';
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
		}
	}

	/** Save a token setting; resolves to whether it worked. */
	async function saveToken(update: Parameters<EngineClient['updateSettings']>[0]) {
		error = null;
		try {
			apply(await client.updateSettings(update));
			return true;
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
			return false;
		}
	}

	const agentNames = { claude: 'Claude Code', codex: 'Codex' } as const;
	/** The agent the chosen model runs in, as picked (before saving). */
	const agent = $derived(providerOf(model) === 'openai' ? 'codex' : 'claude');
	const sandbox = $derived(
		settings?.agentSandbox[agent] ?? { available: false, missing: [], blocked: false, setup: false }
	);

	let copied = $state(false);
	async function copyInstall(command: string) {
		await navigator.clipboard.writeText(command);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	let settingUp = $state(false);
	async function setUpSandbox() {
		error = null;
		settingUp = true;
		try {
			// Not `apply`: that would undo a model picked but not saved yet.
			settings = await client.setUpAgentSandbox({ agent });
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
		} finally {
			settingUp = false;
		}
	}

	const keyStatus = $derived(
		settings?.anthropicApiKey.source === 'saved'
			? m.settings_key_status_saved()
			: settings?.anthropicApiKey.source === 'environment'
				? m.settings_key_status_environment()
				: m.settings_key_status_none()
	);
</script>

{#if settings}
	<div class="grid gap-8">
		<SettingsSection
			id="ai"
			title={m.settings_ai_title()}
			description={m.settings_section_ai_description()}
		>
			<Card.Root>
				<Card.Content class="grid gap-6">
					<form
						class="grid gap-4 sm:max-w-md"
						onsubmit={(e) => {
							e.preventDefault();
							save('ai', {
								model,
								timeoutMinutes: Number(timeoutMinutes),
								concurrency: Number(concurrency),
								autoModeModel: autoMode === RULES_ONLY ? null : autoMode
							});
						}}
					>
						<div class="grid gap-2">
							<Label for="model">{m.settings_model_label()}</Label>
							<ModelPicker id="model" bind:value={model} />
						</div>
						<div class="grid gap-2">
							<Label for="auto-mode">{m.settings_auto_mode_label()}</Label>
							<Select.Root type="single" bind:value={autoMode}>
								<Select.Trigger id="auto-mode" class="w-full" data-testid="auto-mode-model">
									<span class="truncate">{autoModeName}</span>
								</Select.Trigger>
								<Select.Content>
									{#each autoModeModels as model (model.id)}
										<Select.Item value={model.id} label={model.name} />
									{/each}
									<Select.Separator />
									<Select.Item value={RULES_ONLY} label={m.settings_auto_mode_rules()} />
								</Select.Content>
							</Select.Root>
							<p class="text-xs text-muted-foreground">{m.settings_auto_mode_hint()}</p>
						</div>
						<div class="grid gap-4 sm:grid-cols-2">
							<div class="grid gap-2">
								<Label for="timeout">{m.settings_timeout_label()}</Label>
								<Input id="timeout" type="number" min={1} max={240} bind:value={timeoutMinutes} />
							</div>
							<div class="grid gap-2">
								<Label for="concurrency">{m.settings_concurrency_label()}</Label>
								<Input id="concurrency" type="number" min={1} max={8} bind:value={concurrency} />
							</div>
						</div>
						<div class="flex items-center gap-3">
							<Button type="submit">{m.settings_save()}</Button>
							{#if saved === 'ai'}<span class="text-sm text-muted-foreground" role="status"
									>{m.settings_saved()}</span
								>{/if}
						</div>
					</form>

					<p
						class={[
							'text-sm sm:max-w-xl',
							sandbox.available ? 'text-muted-foreground' : 'text-destructive'
						]}
						data-testid="sandbox-status"
						data-agent={agent}
						data-available={sandbox.available}
					>
						{sandbox.available
							? m.settings_sandbox_on({ agent: agentNames[agent] })
							: agent === 'codex'
								? sandbox.setup
									? m.settings_sandbox_codex_setup()
									: sandbox.blocked
										? m.settings_sandbox_codex_blocked()
										: m.settings_sandbox_codex_unsupported()
								: sandbox.missing.length > 0
									? m.settings_sandbox_missing({ tools: sandbox.missing.join(' + ') })
									: sandbox.blocked
										? m.settings_sandbox_blocked()
										: m.settings_sandbox_unsupported()}
					</p>
					{#if !sandbox.available && sandbox.install}
						<div class="grid gap-2 sm:max-w-xl" data-testid="sandbox-install">
							<p class="text-sm text-muted-foreground">{m.settings_sandbox_install()}</p>
							<div class="flex items-center gap-2">
								<code
									class="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm"
									>{sandbox.install}</code
								>
								<Button
									variant="outline"
									size="sm"
									onclick={() => copyInstall(sandbox.install ?? '')}
									><Copy />{copied
										? m.settings_sandbox_install_copied()
										: m.settings_sandbox_install_copy()}</Button
								>
							</div>
						</div>
					{/if}
					{#if !sandbox.available && sandbox.setup}
						<div>
							<Button variant="outline" disabled={settingUp} onclick={setUpSandbox}
								>{settingUp
									? m.settings_sandbox_codex_setting_up()
									: m.settings_sandbox_codex_setup_button()}</Button
							>
						</div>
					{/if}

					<Separator />

					<form
						class="grid gap-3 sm:max-w-md"
						onsubmit={(e) => {
							e.preventDefault();
							save('key', { anthropicApiKey: apiKey });
						}}
					>
						<div>
							<h3 class="text-sm font-medium">{m.settings_key_title()}</h3>
							<p class="text-xs text-muted-foreground">{m.settings_key_description()}</p>
						</div>
						<p class="text-sm" data-testid="key-status">{keyStatus}</p>
						{#if !settings.anthropicApiKey.encrypted}
							<p class="text-xs text-muted-foreground">{m.settings_key_unencrypted()}</p>
						{/if}
						<div class="grid gap-2">
							<Label for="api-key">{m.settings_key_label()}</Label>
							<Input
								id="api-key"
								type="password"
								autocomplete="off"
								placeholder={m.settings_key_placeholder()}
								bind:value={apiKey}
							/>
						</div>
						<div class="flex flex-wrap items-center gap-3">
							<Button type="submit" variant="outline" disabled={!apiKey.trim()}
								>{m.settings_key_save()}</Button
							>
							{#if settings.anthropicApiKey.source === 'saved'}
								<Button
									type="button"
									variant="ghost"
									onclick={() => save('key', { anthropicApiKey: null })}
									>{m.settings_key_remove()}</Button
								>
							{/if}
							{#if saved === 'key'}<span class="text-sm text-muted-foreground" role="status"
									>{m.settings_saved()}</span
								>{/if}
						</div>
					</form>

					<Separator />

					<div class="grid gap-3">
						<div>
							<h3 class="text-sm font-medium">{m.settings_openai_key_title()}</h3>
							<p class="text-xs text-muted-foreground">{m.settings_openai_key_description()}</p>
						</div>
						<TokenField
							id="openai"
							kind="key"
							placeholder="sk-…"
							tokenState={settings.openaiApiKey}
							environmentLabel={m.settings_openai_key_status_environment()}
							onSave={(key) => saveToken({ openaiApiKey: key })}
						/>
					</div>
				</Card.Content>
			</Card.Root>
		</SettingsSection>

		<SettingsSection
			id="git"
			title={m.settings_section_git()}
			description={m.settings_section_git_description()}
		>
			<GitHubSignIn
				{client}
				{events}
				{settings}
				onSettings={apply}
				onSaveToken={(token) => saveToken({ githubToken: token })}
			/>
			<Card.Root>
				<Card.Header>
					<Card.Title>{m.settings_gitlab_title()}</Card.Title>
					<Card.Description>{m.settings_gitlab_description()}</Card.Description>
				</Card.Header>
				<Card.Content>
					<TokenField
						id="gitlab"
						placeholder={m.settings_gitlab_placeholder()}
						tokenState={settings.gitlabToken}
						environmentLabel={m.settings_gitlab_status_environment()}
						onSave={(token) => saveToken({ gitlabToken: token })}
					/>
				</Card.Content>
			</Card.Root>
		</SettingsSection>

		<SettingsSection
			id="templates"
			title={m.settings_section_templates()}
			description={m.settings_section_templates_description()}
		>
			<TemplateSettings {client} />
		</SettingsSection>

		<SettingsSection
			id="reviews"
			title={m.settings_section_reviews()}
			description={m.settings_section_reviews_description()}
		>
			<ReviewAttributeSettings {client} />
		</SettingsSection>

		{#if error}
			<p role="alert" class="text-sm text-destructive">{engineErrorMessage(error)}</p>
		{/if}
	</div>
{/if}
