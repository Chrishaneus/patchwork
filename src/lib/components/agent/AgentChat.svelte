<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import GitPullRequestArrow from '@lucide/svelte/icons/git-pull-request-arrow';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import AgentComposer from '#lib/components/agent/AgentComposer.svelte';
	import AgentThread from '#lib/components/agent/AgentThread.svelte';
	import ExplorationReport from '#lib/components/explore/ExplorationReport.svelte';
	import ReviewReport from '#lib/components/reviews/ReviewReport.svelte';
	import { approachInstruction } from '#lib/components/explore/approach.js';
	import MobilePanel from '#lib/components/shared/MobilePanel.svelte';
	import TaskStatusBadge from '#lib/components/runs/TaskStatusBadge.svelte';
	import ApprovalCard from '#lib/components/runs/ApprovalCard.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { buildThread } from '#lib/components/agent/agent-thread.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import {
		activeTaskStatuses,
		type Approach,
		type EngineErrorCode,
		type Run,
		type Task
	} from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let { run, runs, client }: { run: Run; runs: RunsState; client: EngineClient } = $props();

	/** 'all', or one task's id. */
	let tab = $state('all');

	onMount(() => {
		for (const task of run.tasks) runs.loadLog(task.id);
	});

	const targets = $derived(tab === 'all' ? run.tasks : run.tasks.filter((t) => t.id === tab));
	const working = $derived(targets.some((t) => activeTaskStatuses.includes(t.status)));
	const workingCount = $derived(
		run.tasks.filter((t) => activeTaskStatuses.includes(t.status)).length
	);
	const kind = $derived(run.kind ?? 'code');
	// Replies go to changes that still have a working copy (in review, failed or cancelled).
	// Reviews and explorations answer questions once they're done; each gets a fresh copy.
	const canReply = (t: Task) =>
		kind === 'code'
			? ['awaiting_review', 'failed', 'cancelled'].includes(t.status) && !!t.worktreePath
			: ['completed', 'failed', 'cancelled'].includes(t.status);
	const replyable = $derived(targets.filter(canReply));
	const thread = $derived(buildThread(run, runs.logs, tab === 'all' ? undefined : tab));
	let switchError = $state<EngineErrorCode | null>(null);
	const errors = $derived([
		...new Set([...targets.map((t) => runs.actionErrors[t.id]), switchError].filter(Boolean))
	]);

	// A question or exploration can become a change, in this conversation. Auto: the model decides
	// from your reply. The keyword rules don't count here: most replies they don't recognise would
	// become changes.
	type Target = 'reply' | 'change';
	const switchable = $derived(kind === 'ask' || kind === 'explore');
	const replyName = () => (kind === 'explore' ? m.agent_mode_explore() : m.agent_mode_ask());
	let draft = $state('');
	let auto = $state(true);
	let target = $state<Target>('reply');
	let deciding = $state(false);
	/** The model's answer, for the text it was asked about. */
	let decided: { text: string; target: Target } | null = null;
	/** Only the latest question's answer counts. */
	let question = 0;

	async function decide(message: string): Promise<Target> {
		const answer = await client.classifyMessage({ text: message }).catch(() => null);
		return answer?.source === 'ai' && answer.mode === 'change' ? 'change' : 'reply';
	}

	$effect(() => {
		const id = ++question;
		untrack(() => (deciding = false));
		if (!switchable || !auto) return;
		const message = draft.trim();
		if (!message) return;
		const timer = setTimeout(async () => {
			if (id !== question) return;
			deciding = true;
			const next = await decide(message);
			if (id !== question) return;
			deciding = false;
			decided = { text: message, target: next };
			target = next;
		}, 800);
		return () => clearTimeout(timer);
	});

	async function reply(text: string) {
		switchError = null;
		if (switchable) {
			let goal = target;
			if (auto) {
				// Send what the model says about this exact text; an earlier answer must not land later.
				const known = decided?.text === text ? decided.target : null;
				question++;
				deciding = !known;
				goal = known ?? (await decide(text));
				deciding = false;
			}
			if (goal === 'change') {
				switchError = await runs.switchToChange(run.id, text);
				return !switchError;
			}
		}
		await Promise.all(replyable.map((t) => runs.followUp(t.id, text)));
		return replyable.every((t) => !runs.actionErrors[t.id]);
	}

	/** Explore: build an approach as a new change, in a new conversation. */
	async function build(task: Task, approach: Approach) {
		const next = await runs.start({
			repositoryIds: [task.repositoryId],
			instruction: approachInstruction(run.instruction, approach)
		});
		await goto(resolve(localizeHref(`/agent/${next.id}`) as Path));
	}

	function stop() {
		for (const t of targets) if (activeTaskStatuses.includes(t.status)) runs.cancel(t.id);
	}
</script>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
	<div class="order-2 flex h-[calc(100svh-8rem)] min-h-[28rem] min-w-0 flex-col gap-3 lg:order-1">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<h1
				class="line-clamp-2 min-w-0 flex-1 text-xl font-semibold tracking-tight [overflow-wrap:anywhere]"
			>
				{run.kind === 'review'
					? (run.pullRequests?.length ?? 0) > 1
						? m.review_run_title_many({ count: run.pullRequests!.length })
						: m.review_run_title({ title: run.pullRequest?.title ?? run.instruction })
					: run.instruction}
			</h1>
			<Button variant="outline" size="sm" href={resolve(localizeHref(`/runs/${run.id}`) as Path)}>
				<GitPullRequestArrow />{kind === 'code' ? m.agent_review() : m.agent_details()}
			</Button>
		</div>

		<AgentThread items={thread} showRepos={tab === 'all' && run.tasks.length > 1} {working}>
			{#snippet report(taskId)}
				{@const task = run.tasks.find((t) => t.id === taskId)}
				{#if task?.review}
					<ReviewReport
						review={task.review}
						pullRequest={run.pullRequest}
						onPost={(url) => runs.postReview(task.id, url)}
					/>
				{:else if task?.exploration}
					<ExplorationReport
						exploration={task.exploration}
						onBuild={(approach) => build(task, approach)}
					/>
				{/if}
			{/snippet}
		</AgentThread>

		{#each targets as task (task.id)}
			{#if task.approval}
				<ApprovalCard
					approval={task.approval}
					repository={run.tasks.length > 1 ? task.repositoryName : undefined}
					onAnswer={(answer) => runs.answerApproval(task.id, task.approval!.id, answer)}
				/>
			{/if}
		{/each}

		{#each errors as code (code)}
			<p role="alert" class="text-sm text-destructive">{engineErrorMessage(code!)}</p>
		{/each}
		{#if !working && replyable.length === 0}
			<p class="text-sm text-muted-foreground">{m.agent_cannot_reply()}</p>
		{/if}
		<AgentComposer
			placeholder={kind === 'code'
				? m.agent_placeholder_reply()
				: switchable && target === 'change'
					? m.agent_placeholder_switch()
					: m.agent_placeholder_question()}
			label={kind === 'code' ? undefined : m.agent_placeholder_question()}
			bind:text={draft}
			busy={working}
			disabled={!working && replyable.length === 0}
			onSend={reply}
			onStop={stop}
			toolbar={switchable ? replyMode : undefined}
		/>
	</div>

	{#snippet replyMode()}
		<div class="flex flex-col gap-1">
			<ToggleGroup.Root
				type="single"
				variant="outline"
				size="sm"
				class="self-start"
				value={auto ? 'auto' : target}
				onValueChange={(v) => {
					if (!v) return;
					if (v === 'auto') auto = true;
					else {
						auto = false;
						target = v as Target;
					}
				}}
				aria-label={m.agent_mode_label()}
				data-testid="agent-reply-mode"
				data-mode={target}
				data-auto={auto}
			>
				<ToggleGroup.Item value="auto" title={m.agent_reply_auto_hint()} aria-busy={deciding}
					>{#if deciding}<LoaderCircle class="animate-spin" />{:else}<Sparkles />{/if}{auto &&
					draft.trim()
						? m.agent_mode_auto_detected({
								mode: target === 'change' ? m.agent_mode_change() : replyName()
							})
						: m.agent_mode_auto()}</ToggleGroup.Item
				>
				<ToggleGroup.Item value="reply">{replyName()}</ToggleGroup.Item>
				<ToggleGroup.Item value="change">{m.agent_mode_change()}</ToggleGroup.Item>
			</ToggleGroup.Root>
			{#if target === 'change'}
				<p class="text-xs text-muted-foreground">{m.agent_switch_hint()}</p>
			{/if}
		</div>
	{/snippet}

	<!-- Repositories in this conversation: pick one to talk to it alone, or all of them. -->
	<MobilePanel
		title={m.agent_repos()}
		summary={[
			tab === 'all'
				? `${m.agent_all()} (${run.tasks.length})`
				: (run.tasks.find((t) => t.id === tab)?.repositoryName ?? ''),
			workingCount > 0 ? m.agent_working_count({ count: workingCount }) : null
		]
			.filter(Boolean)
			.join(' · ')}
		testid="agent-conversation-repos"
		scroll
		class="order-1 lg:order-2 lg:self-start"
	>
		<div class="p-2">
			<p class="hidden px-2 pt-1 pb-2 text-sm font-medium lg:block">{m.agent_repos()}</p>
			<div class="flex flex-col gap-1" role="tablist" aria-orientation="vertical">
				{#if run.tasks.length > 1}
					<button
						type="button"
						role="tab"
						aria-selected={tab === 'all'}
						class="flex items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted aria-selected:bg-muted aria-selected:font-medium"
						onclick={() => (tab = 'all')}
					>
						{m.agent_all()}
						<span class="text-xs text-muted-foreground">{run.tasks.length}</span>
					</button>
				{/if}
				{#each run.tasks as task (task.id)}
					<button
						type="button"
						role="tab"
						aria-selected={tab === task.id || run.tasks.length === 1}
						class="flex flex-col items-start gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-muted aria-selected:bg-muted aria-selected:font-medium"
						onclick={() => (tab = run.tasks.length === 1 ? 'all' : task.id)}
						data-testid="agent-task"
						data-task-status={task.status}
					>
						<span class="w-full truncate" title={task.repositoryName}>{task.repositoryName}</span>
						<TaskStatusBadge status={task.status} />
					</button>
				{/each}
			</div>
		</div>
	</MobilePanel>
</div>
