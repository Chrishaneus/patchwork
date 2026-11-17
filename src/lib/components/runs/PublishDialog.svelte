<script lang="ts">
	import GitPullRequestArrow from '@lucide/svelte/icons/git-pull-request-arrow';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { ReviewedPullRequest, Task } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let {
		task,
		instruction,
		remoteName,
		provider,
		updates,
		runs
	}: {
		task: Task;
		instruction: string;
		remoteName: string;
		/** Where the pull request is opened; null when the branch is only pushed. */
		provider: 'github' | 'gitlab' | null;
		/** The pull request the change is pushed to, instead of opening one. */
		updates?: ReviewedPullRequest;
		runs: RunsState;
	} = $props();
	/** A squash of the pull request's commits: publishing replaces them with one. */
	const squash = $derived(!!updates && !!task.squashedFrom);
	const pullLabel = $derived(
		updates ? `${updates.provider === 'gitlab' ? '!' : '#'}${updates.number}` : ''
	);

	/** First line of the instruction, kept to a typical commit-subject length: the fallback title. */
	function defaultTitle(text: string) {
		const line = text.trim().split('\n')[0];
		return line.length > 72 ? `${line.slice(0, 71)}…` : line;
	}

	let open = $state(false);
	let title = $state('');
	let body = $state('');
	let draft = $state(false);
	/** A change to a pull request: the reply posted on it after the push, if `replying`. */
	let reply = $state('');
	let replying = $state(true);
	let busy = $state(false);
	const actionError = $derived(runs.actionErrors[task.id]);

	function reset() {
		// The agent's title when it gave one, else the start of what was asked.
		title = task.title || defaultTitle(instruction);
		body = task.summary ?? '';
		draft = false;
		// What it changed for each comment, which is also what reviewers want to read.
		reply = task.summary ?? '';
		// A squash changes no code, so it says nothing new to reviewers unless you want to.
		replying = !squash;
	}

	async function publish(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		const result = await runs.publish({
			taskId: task.id,
			title,
			body,
			draft,
			...(updates && replying && reply.trim() ? { reply } : {})
		});
		busy = false;
		// Close on success, and also on a publish error: the task card shows it with a retry.
		if (result) open = false;
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (next) reset();
	}}
>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} size="sm">
				<GitPullRequestArrow />{task.publishError
					? m.publish_retry()
					: squash
						? m.task_squash_pr({ number: pullLabel })
						: updates
							? m.task_push_to_pr({ number: pullLabel })
							: provider === 'gitlab'
								? m.task_open_mr()
								: m.task_open_pr()}
			</Button>
		{/snippet}
	</Dialog.Trigger>
	<!-- Never taller than the screen, so the button stays reachable however long the text. -->
	<Dialog.Content class="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
		<form class="grid gap-4" onsubmit={publish}>
			<Dialog.Header>
				<Dialog.Title
					>{squash
						? m.publish_title_squash({ number: pullLabel })
						: updates
							? m.publish_title_update({ number: pullLabel })
							: provider === 'gitlab'
								? m.publish_title_gitlab()
								: m.publish_title()}</Dialog.Title
				>
				<Dialog.Description>
					{squash
						? m.publish_description_squash({
								branch: task.branch,
								remote: remoteName,
								number: pullLabel
							})
						: updates
							? m.publish_description_update({
									branch: task.branch,
									remote: remoteName,
									number: pullLabel
								})
							: provider === 'github'
								? m.publish_description({
										branch: task.branch,
										remote: remoteName,
										base: task.baseBranch
									})
								: provider === 'gitlab'
									? m.publish_description_gitlab({
											branch: task.branch,
											remote: remoteName,
											base: task.baseBranch
										})
									: m.publish_description_no_github({ branch: task.branch, remote: remoteName })}
				</Dialog.Description>
			</Dialog.Header>
			<div class="grid gap-2">
				<Label for="pr-title">{updates ? m.publish_commit_title() : m.publish_pr_title()}</Label>
				<Input id="pr-title" bind:value={title} required />
			</div>
			<div class="grid gap-2">
				<Label for="pr-body">{updates ? m.publish_commit_body() : m.publish_pr_body()}</Label>
				<!-- It grows with its text up to half the screen, then scrolls. -->
				<Textarea
					id="pr-body"
					rows={10}
					class="max-h-[50svh] overflow-y-auto font-mono text-xs"
					bind:value={body}
				/>
			</div>
			{#if updates}
				<div class="grid gap-2" data-testid="publish-reply">
					<Label class="flex items-center gap-2">
						<Checkbox checked={replying} onCheckedChange={(v) => (replying = v === true)} />
						{m.publish_reply({ number: pullLabel })}
					</Label>
					{#if replying}
						<Textarea
							id="pr-reply"
							aria-label={m.publish_reply({ number: pullLabel })}
							rows={6}
							class="max-h-[30svh] overflow-y-auto font-mono text-xs"
							bind:value={reply}
						/>
						<p class="text-xs text-muted-foreground">{m.publish_reply_hint()}</p>
					{/if}
				</div>
			{/if}
			{#if provider && !updates}
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox checked={draft} onCheckedChange={(v) => (draft = v === true)} />
					{m.publish_draft()}
				</Label>
			{/if}
			{#if actionError}
				<p role="alert" class="text-sm text-destructive">{engineErrorMessage(actionError)}</p>
			{/if}
			<Dialog.Footer>
				<Button type="submit" disabled={busy || !title.trim()}>
					{busy
						? m.publish_submitting()
						: squash
							? m.publish_submit_squash()
							: updates
								? m.publish_submit_update()
								: m.publish_submit()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
