<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import GitPullRequestDraft from '@lucide/svelte/icons/git-pull-request-draft';
	import Lightbulb from '@lucide/svelte/icons/lightbulb';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import AgentComposer from '#lib/components/AgentComposer.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import MobilePanel from '#lib/components/MobilePanel.svelte';
	import PullRequestPicker from '#lib/components/PullRequestPicker.svelte';
	import RepositoryPicker from '#lib/components/RepositoryPicker.svelte';
	import ReviewAttributePicker from '#lib/components/ReviewAttributePicker.svelte';
	import TemplatePicker from '#lib/components/TemplatePicker.svelte';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { detectAgentMode, findPullRequestLink, type AgentMode } from '#lib/agent-mode.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import { EngineError, type EngineErrorCode, type ReviewAttribute } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import type { RepositoriesState } from '#lib/repositories.svelte.js';
	import { RepositoryChoices } from '#lib/repository-choices.svelte.js';
	import type { RunsState } from '#lib/runs.svelte.js';

	let {
		repositories,
		runs,
		client,
		mode = $bindable('change'),
		pinned = false
	}: {
		repositories: RepositoriesState;
		runs: RunsState;
		client: EngineClient;
		mode?: AgentMode;
		/** The mode came from the link (`?mode=`): don't guess it from the message. */
		pinned?: boolean;
	} = $props();

	// The engine connection doesn't change while the page is shown.
	const choices = untrack(() => new RepositoryChoices(repositories, client));
	let selected = $state<string[]>([]);
	let text = $state('');
	let branch = $state('');
	let repositoryId = $state('');
	let pullNumber = $state('');
	let attributes = $state<ReviewAttribute[]>([]);
	let chosen = $state<string[]>([]);
	let error = $state<EngineErrorCode | 'no_repos' | 'no_pull' | 'no_attributes' | null>(null);

	onMount(async () => {
		choices.load();
		if (!repositories.loaded) repositories.load();
		attributes = (await client.getSettings({}).catch(() => null))?.reviewAttributes ?? [];
		chosen = attributes.map((a) => a.id);
	});

	// Auto: the mode follows what the message asks for. The keyword rules answer at once, then a
	// small model decides once you pause typing. Picking a mode yourself turns that off until you
	// pick Auto again.
	let auto = $state(untrack(() => !pinned));
	let deciding = $state(false);
	/** Only the latest question's answer counts; earlier ones are for text you've since changed. */
	let question = 0;
	const link = $derived(findPullRequestLink(text));
	function follow(detected: AgentMode) {
		if (detected !== mode) {
			mode = detected;
			error = null;
		}
	}
	$effect(() => {
		const id = ++question;
		untrack(() => (deciding = false));
		if (!auto) return;
		const message = text;
		untrack(() => follow(detectAgentMode(message)));
		if (!message.trim() || findPullRequestLink(message)) return;
		const timer = setTimeout(async () => {
			deciding = true;
			const answer = await client.classifyMessage({ text: message }).catch(() => null);
			if (id !== question) return;
			deciding = false;
			if (answer) follow(answer.mode);
		}, 800);
		return () => clearTimeout(timer);
	});
	const modeNames: Record<AgentMode, () => string> = {
		change: m.agent_mode_change,
		review: m.agent_mode_review,
		explore: m.agent_mode_explore,
		ask: m.agent_mode_ask
	};

	const reviewReady = $derived(!!link || (!!repositoryId && !!pullNumber));
	const placeholder = $derived(
		auto && !text.trim()
			? m.agent_placeholder_auto()
			: mode === 'review'
				? m.agent_placeholder_review()
				: mode === 'explore'
					? m.agent_placeholder_explore()
					: mode === 'ask'
						? m.agent_placeholder_ask()
						: m.agent_placeholder_start()
	);
	const intro = $derived(
		mode === 'review'
			? {
					icon: GitPullRequestDraft,
					title: m.agent_start_title_review(),
					hint: m.agent_start_hint_review()
				}
			: mode === 'explore'
				? {
						icon: Lightbulb,
						title: m.agent_start_title_explore(),
						hint: m.agent_start_hint_explore()
					}
				: mode === 'ask'
					? {
							icon: MessageCircleQuestion,
							title: m.agent_start_title_ask(),
							hint: m.agent_start_hint_ask()
						}
					: { icon: MessagesSquare, title: m.agent_start_title(), hint: m.agent_start_hint() }
	);
	const errorText = $derived(
		error === 'no_repos'
			? m.agent_pick_repos()
			: error === 'no_pull'
				? m.agent_pick_pull()
				: error === 'no_attributes'
					? m.agent_pick_attributes()
					: error
						? engineErrorMessage(error)
						: null
	);

	/** The first message starts a run (change, review or exploration), then the conversation opens. */
	async function start(message: string) {
		// Send in the mode that's shown; a late answer must not switch it afterwards.
		question++;
		deciding = false;
		error = null;
		try {
			let runId: string;
			if (mode === 'review') {
				if (!reviewReady) return ((error = 'no_pull'), false);
				const picked = attributes.filter((a) => chosen.includes(a.id));
				if (picked.length === 0) return ((error = 'no_attributes'), false);
				const run = await runs.startReview(
					link
						? { url: link, instruction: message || undefined, attributes: picked }
						: {
								repositoryId,
								number: Number(pullNumber),
								instruction: message || undefined,
								attributes: picked
							}
				);
				runId = run.id;
			} else {
				if (selected.length === 0) return ((error = 'no_repos'), false);
				const repositoryIds = await choices.resolve(selected);
				const run =
					mode === 'explore'
						? await runs.startExplore({ repositoryIds, idea: message })
						: mode === 'ask'
							? await runs.startAsk({ repositoryIds, question: message })
							: await runs.start({
									repositoryIds,
									instruction: message,
									branch: selected.length === 1 && branch.trim() ? branch.trim() : undefined
								});
				runId = run.id;
			}
			await goto(resolve(localizeHref(`/agent/${runId}`) as Path));
			return true;
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
			return false;
		}
	}
</script>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
	<!-- The conversation area: what to do, and the message box at the bottom. -->
	<div
		class="order-2 flex min-h-[24rem] min-w-0 flex-col gap-3 lg:order-1 lg:h-[calc(100svh-12rem)]"
	>
		<div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
			<intro.icon class="size-8 text-muted-foreground" />
			<p class="font-medium">{intro.title}</p>
			<p class="max-w-md text-sm text-muted-foreground">{intro.hint}</p>
		</div>
		{#if errorText}
			<p role="alert" class="text-sm text-destructive">{errorText}</p>
		{/if}
		<AgentComposer
			{placeholder}
			label={m.agent_message_label()}
			bind:text
			allowEmpty={mode === 'review' && reviewReady}
			onSend={start}
		>
			{#snippet toolbar()}
				<div class="flex flex-wrap items-center gap-2">
					<ToggleGroup.Root
						type="single"
						variant="outline"
						size="sm"
						value={auto ? 'auto' : mode}
						onValueChange={(v) => {
							if (!v) return;
							error = null;
							if (v === 'auto') {
								auto = true;
							} else {
								auto = false;
								mode = v as AgentMode;
							}
						}}
						aria-label={m.agent_mode_label()}
						data-testid="agent-mode"
						data-mode={mode}
						data-auto={auto}
					>
						<ToggleGroup.Item value="auto" title={m.agent_mode_auto_hint()} aria-busy={deciding}
							>{#if deciding}<LoaderCircle class="animate-spin" />{:else}<Sparkles />{/if}{auto &&
							text.trim()
								? m.agent_mode_auto_detected({ mode: modeNames[mode]() })
								: m.agent_mode_auto()}</ToggleGroup.Item
						>
						<ToggleGroup.Item value="change">{m.agent_mode_change()}</ToggleGroup.Item>
						<ToggleGroup.Item value="ask">{m.agent_mode_ask()}</ToggleGroup.Item>
						<ToggleGroup.Item value="review">{m.agent_mode_review()}</ToggleGroup.Item>
						<ToggleGroup.Item value="explore">{m.agent_mode_explore()}</ToggleGroup.Item>
					</ToggleGroup.Root>
				</div>
			{/snippet}
		</AgentComposer>
		{#if mode === 'change'}
			<TemplatePicker {client} bind:instruction={text} />
		{/if}
	</div>

	<!-- The side panel: repositories, or the pull request and what to rate. -->
	{#if mode === 'review'}
		<MobilePanel
			title={m.agent_panel_review()}
			summary={link
				? m.agent_review_link_short()
				: pullNumber
					? `#${pullNumber}`
					: m.agent_review_none()}
			testid="agent-review-panel"
			scroll
			class="order-1 flex flex-col lg:order-2 lg:max-h-[calc(100svh-12rem)]"
		>
			<div class="flex min-h-0 flex-col gap-4 p-3">
				<div class="flex flex-col gap-2">
					<p class="hidden text-sm font-medium lg:block">{m.agent_panel_review()}</p>
					{#if link}
						<p class="text-xs [overflow-wrap:anywhere] text-muted-foreground">
							{m.agent_review_link({ link })}
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">{m.agent_review_pick_hint()}</p>
						<PullRequestPicker
							{client}
							repositories={repositories.items}
							bind:repositoryId
							bind:pullNumber
						/>
					{/if}
				</div>
				<Separator />
				<div class="flex flex-col gap-2">
					<p class="text-sm font-medium">{m.review_attributes_label()}</p>
					<ReviewAttributePicker bind:attributes bind:chosen />
				</div>
			</div>
		</MobilePanel>
	{:else}
		<MobilePanel
			title={m.agent_repos()}
			summary={m.new_change_selected({ count: selected.length })}
			testid="agent-repositories"
			class="order-1 flex flex-col lg:order-2 lg:max-h-[calc(100svh-12rem)]"
		>
			<div class="flex min-h-0 flex-col p-3">
				<p class="hidden text-sm font-medium lg:block">{m.agent_repos()}</p>
				<p class="mb-3 text-xs text-muted-foreground">
					{mode === 'explore'
						? m.explore_repos_hint()
						: mode === 'ask'
							? m.agent_repos_hint_ask()
							: m.agent_repos_hint()}
				</p>
				{#if choices.loaded && choices.available.length === 0}
					<p class="text-sm text-muted-foreground">{m.new_change_no_repos()}</p>
					<Button
						variant="outline"
						size="sm"
						class="mt-2 self-start"
						href={resolve(localizeHref('/repositories') as Path)}>{m.agent_add_repos()}</Button
					>
				{:else}
					<div class="flex min-h-0 flex-1 flex-col">
						<RepositoryPicker {choices} bind:selected compact />
					</div>
				{/if}
				{#if mode === 'change' && selected.length === 1}
					<div class="mt-3 flex flex-col gap-1.5 border-t pt-3">
						<Label for="branch">{m.new_change_branch_label()}</Label>
						<Input
							id="branch"
							class="h-8 font-mono text-xs"
							autocomplete="off"
							spellcheck={false}
							bind:value={branch}
						/>
						<p class="text-xs text-muted-foreground">{m.new_change_branch_hint()}</p>
					</div>
				{/if}
			</div>
		</MobilePanel>
	{/if}
</div>
