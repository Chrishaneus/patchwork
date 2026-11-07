<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import GitPullRequestArrow from '@lucide/svelte/icons/git-pull-request-arrow';
	import AgentComposer from '#lib/components/AgentComposer.svelte';
	import AgentThread from '#lib/components/AgentThread.svelte';
	import ExplorationReport from '#lib/components/ExplorationReport.svelte';
	import ReviewReport from '#lib/components/ReviewReport.svelte';
	import { approachInstruction } from '#lib/approach.js';
	import MobilePanel from '#lib/components/MobilePanel.svelte';
	import TaskStatusBadge from '#lib/components/TaskStatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { buildThread } from '#lib/agent-thread.js';
	import { activeTaskStatuses, type Approach, type Run, type Task } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import type { RunsState } from '#lib/runs.svelte.js';

	let { run, runs }: { run: Run; runs: RunsState } = $props();

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
	const errors = $derived(targets.map((t) => runs.actionErrors[t.id]).filter(Boolean));

	async function reply(text: string) {
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
					? m.review_run_title({ title: run.pullRequest?.title ?? run.instruction })
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
						onPost={() => runs.postReview(task.id)}
					/>
				{:else if task?.exploration}
					<ExplorationReport
						exploration={task.exploration}
						onBuild={(approach) => build(task, approach)}
					/>
				{/if}
			{/snippet}
		</AgentThread>

		{#each errors as code (code)}
			<p role="alert" class="text-sm text-destructive">{engineErrorMessage(code!)}</p>
		{/each}
		{#if !working && replyable.length === 0}
			<p class="text-sm text-muted-foreground">{m.agent_cannot_reply()}</p>
		{/if}
		<AgentComposer
			placeholder={kind === 'code' ? m.agent_placeholder_reply() : m.agent_placeholder_question()}
			busy={working}
			disabled={!working && replyable.length === 0}
			onSend={reply}
			onStop={stop}
		/>
	</div>

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
