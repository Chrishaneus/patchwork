<script lang="ts">
	import Markdown from '#lib/components/Markdown.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ChecksBadge from '#lib/components/ChecksBadge.svelte';
	import DiffView from '#lib/components/DiffView.svelte';
	import ExplorationReport from '#lib/components/ExplorationReport.svelte';
	import ReviewReport from '#lib/components/ReviewReport.svelte';
	import FollowUpForm from '#lib/components/FollowUpForm.svelte';
	import PublishDialog from '#lib/components/PublishDialog.svelte';
	import PullRequestLink from '#lib/components/PullRequestLink.svelte';
	import TaskLog from '#lib/components/TaskLog.svelte';
	import TaskStatusBadge from '#lib/components/TaskStatusBadge.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import {
		activeTaskStatuses,
		type Approach,
		type Repository,
		type ReviewedPullRequest,
		type RunKind,
		type Task
	} from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { formatCost } from '#lib/format.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import { approachInstruction } from '#lib/approach.js';
	import type { RunsState } from '#lib/runs.svelte.js';

	let {
		task,
		runs,
		instruction,
		repository,
		kind = 'code',
		pullRequest
	}: {
		task: Task;
		runs: RunsState;
		instruction: string;
		repository?: Repository;
		kind?: RunKind;
		pullRequest?: ReviewedPullRequest;
	} = $props();

	const code = $derived(kind === 'code');

	/** Explore: start a normal code run that builds the chosen approach. */
	async function build(approach: Approach) {
		const run = await runs.start({
			repositoryIds: [task.repositoryId],
			instruction: approachInstruction(instruction, approach)
		});
		await goto(resolve(localizeHref(`/runs/${run.id}`) as Path));
	}

	let tab = $state('log');
	const active = $derived(activeTaskStatuses.includes(task.status));
	const canDiscard = $derived(
		code && !active && task.status !== 'discarded' && task.status !== 'published'
	);
	const provider = $derived(
		(repository?.provider === 'github' || repository?.provider === 'gitlab') && repository.slug
			? repository.provider
			: null
	);
	const canFollowUp = $derived(
		['awaiting_review', 'failed', 'cancelled'].includes(task.status) && !!task.worktreePath
	);
	const hasChanges = $derived(!!task.worktreePath || task.status === 'published');
	const canRecheck = $derived(task.status === 'awaiting_review' && !!repository?.checkCommand);
	const log = $derived(runs.logs[task.id] ?? []);
	const diff = $derived(runs.diffs[task.id]);
	const actionError = $derived(runs.actionErrors[task.id]);

	onMount(() => {
		runs.loadLog(task.id);
	});

	$effect(() => {
		if (tab === 'changes' && !diff && hasChanges) runs.loadDiff(task.id);
	});
</script>

<Card.Root data-testid="task" data-task-status={task.status}>
	<Card.Header>
		<Card.Title class="flex flex-wrap items-center gap-2">
			<span>{task.repositoryName}</span>
			<TaskStatusBadge status={task.status} />
		</Card.Title>
		<Card.Description class="flex flex-wrap gap-x-4 gap-y-1">
			{#if kind === 'review' && pullRequest}
				<!-- The pull request on GitHub or GitLab; not an app route. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					class="font-mono text-xs underline-offset-2 hover:underline"
					href={pullRequest.url}
					target="_blank"
					rel="noreferrer"
					>#{pullRequest.number} · {m.task_branch({
						branch: pullRequest.headRef,
						base: pullRequest.baseRef
					})}</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{:else if kind === 'explore' || kind === 'ask'}
				<span class="font-mono text-xs">{m.explore_on_branch({ branch: task.baseBranch })}</span>
			{:else}
				<span class="font-mono text-xs"
					>{m.task_branch({ branch: task.branch, base: task.baseBranch })}</span
				>
			{/if}
			{#if task.diffStat}
				<span>{m.task_diffstat({ ...task.diffStat })}</span>
			{/if}
			{#if task.costUsd !== null}
				<span>{m.task_cost({ cost: formatCost(task.costUsd) })}</span>
			{/if}
			{#if task.checks}
				<ChecksBadge checks={task.checks} />
			{/if}
			{#if task.turns !== null}
				<span>{m.task_turns({ count: task.turns })}</span>
			{/if}
		</Card.Description>
		<Card.Action class="flex gap-2">
			{#if active}
				<Button variant="outline" size="sm" onclick={() => runs.cancel(task.id)}
					>{m.task_cancel()}</Button
				>
			{/if}
			{#if canDiscard}
				<AlertDialog.Root>
					<AlertDialog.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="outline" size="sm">{m.task_discard()}</Button>
						{/snippet}
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>{m.task_discard_title()}</AlertDialog.Title>
							<AlertDialog.Description
								>{m.task_discard_body({ branch: task.branch })}</AlertDialog.Description
							>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel>{m.repo_remove_cancel()}</AlertDialog.Cancel>
							<AlertDialog.Action onclick={() => runs.discard(task.id)}
								>{m.task_discard()}</AlertDialog.Action
							>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
			{/if}
			{#if task.status === 'awaiting_review'}
				<PublishDialog
					{task}
					{instruction}
					{runs}
					{provider}
					remoteName={repository?.remoteName ?? 'origin'}
				/>
			{/if}
		</Card.Action>
	</Card.Header>
	<Card.Content>
		{#if task.error}
			<p class="mb-3 text-sm text-destructive" role="alert">
				{engineErrorMessage(task.error.code)}
				<span class="text-muted-foreground">{task.error.message}</span>
			</p>
		{/if}
		{#if actionError}
			<p class="mb-3 text-sm text-destructive" role="alert">{engineErrorMessage(actionError)}</p>
		{/if}
		{#if task.publishError && task.status === 'awaiting_review'}
			<p class="mb-3 text-sm text-destructive" role="alert" data-testid="publish-error">
				{m.publish_failed()}
				{engineErrorMessage(task.publishError.code)}
				<span class="block text-muted-foreground">{task.publishError.message}</span>
			</p>
		{/if}
		{#if task.status === 'published'}
			<div class="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="published">
				{#if task.pullRequest}
					<PullRequestLink pullRequest={task.pullRequest} />
				{:else}
					<span>{m.task_pushed_only({ branch: task.branch })}</span>
				{/if}
			</div>
		{/if}
		{#if task.review}
			<ReviewReport review={task.review} {pullRequest} onPost={() => runs.postReview(task.id)} />
		{/if}
		{#if kind === 'ask' && task.summary && task.status === 'completed'}
			<div class="mb-4 rounded-md border bg-muted/30 p-3" data-testid="answer">
				<Markdown text={task.summary} />
			</div>
		{/if}
		{#if task.exploration}
			<ExplorationReport exploration={task.exploration} onBuild={build} />
		{/if}
		<Tabs.Root bind:value={tab}>
			<Tabs.List>
				<Tabs.Trigger value="log">{m.task_tab_log()}</Tabs.Trigger>
				{#if code}
					<Tabs.Trigger value="changes" disabled={!hasChanges}>{m.task_tab_changes()}</Tabs.Trigger>
					<Tabs.Trigger value="checks" disabled={!task.checks}>{m.task_tab_checks()}</Tabs.Trigger>
					<Tabs.Trigger value="summary">{m.task_tab_summary()}</Tabs.Trigger>
				{/if}
			</Tabs.List>
			<Tabs.Content value="log"><TaskLog entries={log} /></Tabs.Content>
			<Tabs.Content value="changes">
				{#if diff}<DiffView {diff} />{/if}
			</Tabs.Content>
			<Tabs.Content value="checks">
				{#if task.checks}
					<div class="flex flex-col gap-2" data-testid="checks-output">
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<ChecksBadge checks={task.checks} />
							<code class="font-mono text-xs">$ {task.checks.command}</code>
							{#if task.checks.exitCode !== null}
								<span class="text-muted-foreground"
									>{m.checks_exit({ code: task.checks.exitCode })}</span
								>
							{/if}
							{#if canRecheck}
								<Button
									variant="outline"
									size="sm"
									class="ml-auto"
									onclick={() => runs.runChecks(task.id)}
								>
									<RefreshCw />{m.checks_rerun()}
								</Button>
							{/if}
						</div>
						<pre
							class="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">{task
								.checks.output || m.checks_no_output()}</pre>
					</div>
				{/if}
			</Tabs.Content>
			<Tabs.Content value="summary">
				{#if task.summary}
					<Markdown text={task.summary} />
				{:else}
					<p class="text-sm text-muted-foreground">{m.task_summary_empty()}</p>
				{/if}
			</Tabs.Content>
		</Tabs.Root>
		{#if canFollowUp && code}
			<FollowUpForm {task} {runs} />
		{/if}
		{#if task.worktreePath}
			<p class="mt-3 font-mono text-xs break-all text-muted-foreground">
				{m.task_worktree({ path: task.worktreePath })}
			</p>
		{/if}
	</Card.Content>
</Card.Root>
