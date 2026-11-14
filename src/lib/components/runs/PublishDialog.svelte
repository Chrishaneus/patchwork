<script lang="ts">
	import GitPullRequestArrow from '@lucide/svelte/icons/git-pull-request-arrow';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { Task } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let {
		task,
		instruction,
		remoteName,
		provider,
		runs
	}: {
		task: Task;
		instruction: string;
		remoteName: string;
		/** Where the pull request is opened; null when the branch is only pushed. */
		provider: 'github' | 'gitlab' | null;
		runs: RunsState;
	} = $props();

	/** First line of the instruction, kept to a typical commit-subject length: the fallback title. */
	function defaultTitle(text: string) {
		const line = text.trim().split('\n')[0];
		return line.length > 72 ? `${line.slice(0, 71)}…` : line;
	}

	let open = $state(false);
	let title = $state('');
	let body = $state('');
	let draft = $state(false);
	let busy = $state(false);
	const actionError = $derived(runs.actionErrors[task.id]);

	function reset() {
		// The agent's title when it gave one, else the start of what was asked.
		title = task.title || defaultTitle(instruction);
		body = task.summary ?? '';
		draft = false;
	}

	async function publish(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		const result = await runs.publish({ taskId: task.id, title, body, draft });
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
					: provider === 'gitlab'
						? m.task_open_mr()
						: m.task_open_pr()}
			</Button>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-2xl">
		<form class="grid gap-4" onsubmit={publish}>
			<Dialog.Header>
				<Dialog.Title
					>{provider === 'gitlab' ? m.publish_title_gitlab() : m.publish_title()}</Dialog.Title
				>
				<Dialog.Description>
					{provider === 'github'
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
				<Label for="pr-title">{m.publish_pr_title()}</Label>
				<Input id="pr-title" bind:value={title} required />
			</div>
			<div class="grid gap-2">
				<Label for="pr-body">{m.publish_pr_body()}</Label>
				<Textarea id="pr-body" rows={10} class="font-mono text-xs" bind:value={body} />
			</div>
			{#if provider}
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
					{busy ? m.publish_submitting() : m.publish_submit()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
