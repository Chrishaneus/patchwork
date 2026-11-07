<script lang="ts">
	import GitPullRequestArrow from '@lucide/svelte/icons/git-pull-request-arrow';
	import ChecksBadge from '#lib/components/runs/ChecksBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { Run, Task } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RunsState } from '#lib/app/runs.svelte.js';

	let { run, runs }: { run: Run; runs: RunsState } = $props();

	const ready = $derived(run.tasks.filter((t) => t.status === 'awaiting_review'));

	let open = $state(false);
	let selected = $state<string[]>([]);
	let title = $state('');
	let draft = $state(false);
	let progress = $state<{ done: number; total: number } | null>(null);
	/** Outcome per task id after publishing. */
	let results = $state<Record<string, Task | 'error'>>({});

	function reset() {
		// Preselect the changes whose checks passed.
		selected = ready.filter((t) => t.checks?.status === 'passed').map((t) => t.id);
		const line = run.instruction.trim().split('\n')[0];
		title = line.length > 72 ? `${line.slice(0, 71)}…` : line;
		draft = false;
		progress = null;
		results = {};
	}

	function toggle(id: string, on: boolean) {
		selected = on ? [...selected, id] : selected.filter((s) => s !== id);
	}

	async function publish(event: SubmitEvent) {
		event.preventDefault();
		const tasks = run.tasks.filter((t) => selected.includes(t.id));
		progress = { done: 0, total: tasks.length };
		// One at a time: each publish commits, pushes and talks to GitHub.
		for (const task of tasks) {
			const result = await runs.publish({
				taskId: task.id,
				title,
				body: task.summary ?? '',
				draft
			});
			results[task.id] = result ?? 'error';
			progress = { done: progress.done + 1, total: progress.total };
		}
	}

	const finished = $derived(progress !== null && progress.done === progress.total);
	const outcome = (task: Task) => {
		const result = results[task.id];
		if (!result) return null;
		if (result !== 'error' && result.status === 'published')
			return { ok: true, text: m.bulk_publish_ok() };
		const code = result === 'error' ? runs.actionErrors[task.id] : result.publishError?.code;
		return {
			ok: false,
			text: `${m.bulk_publish_failed()}: ${code ? engineErrorMessage(code) : ''}`
		};
	};
</script>

{#if ready.length > 0}
	<Dialog.Root
		bind:open
		onOpenChange={(next) => {
			if (next) reset();
		}}
	>
		<Dialog.Trigger>
			{#snippet child({ props })}
				<Button {...props}><GitPullRequestArrow />{m.bulk_publish_open()}</Button>
			{/snippet}
		</Dialog.Trigger>
		<Dialog.Content class="sm:max-w-2xl">
			<form class="grid gap-4" onsubmit={publish}>
				<Dialog.Header>
					<Dialog.Title>{m.bulk_publish_title()}</Dialog.Title>
					<Dialog.Description>{m.bulk_publish_description()}</Dialog.Description>
				</Dialog.Header>
				<ul class="grid gap-2" data-testid="bulk-publish-tasks">
					{#each ready.concat(run.tasks.filter((t) => results[t.id] && !ready.includes(t))) as task (task.id)}
						{@const result = outcome(task)}
						<li class="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
							<Label class="flex flex-1 items-center gap-2 font-medium">
								<Checkbox
									checked={selected.includes(task.id)}
									disabled={progress !== null}
									onCheckedChange={(v) => toggle(task.id, v === true)}
								/>
								{task.repositoryName}
							</Label>
							<ChecksBadge checks={task.checks} />
							{#if result}
								<span
									class={[
										'text-sm',
										result.ok ? 'text-green-700 dark:text-green-400' : 'text-destructive'
									]}>{result.text}</span
								>
							{/if}
						</li>
					{/each}
				</ul>
				<div class="grid gap-2">
					<Label for="bulk-title">{m.publish_pr_title()}</Label>
					<Input id="bulk-title" bind:value={title} required disabled={progress !== null} />
				</div>
				<Label class="flex items-center gap-2 font-normal">
					<Checkbox
						checked={draft}
						disabled={progress !== null}
						onCheckedChange={(v) => (draft = v === true)}
					/>
					{m.publish_draft()}
				</Label>
				<Dialog.Footer class="items-center">
					{#if progress && !finished}
						<span class="text-sm text-muted-foreground" role="status"
							>{m.bulk_publish_progress({ done: progress.done, total: progress.total })}</span
						>
					{/if}
					{#if finished}
						<Button type="button" variant="outline" onclick={() => (open = false)}
							>{m.bulk_publish_close()}</Button
						>
					{:else}
						<Button
							type="submit"
							disabled={progress !== null || selected.length === 0 || !title.trim()}
						>
							{m.bulk_publish_submit({ count: selected.length })}
						</Button>
					{/if}
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
