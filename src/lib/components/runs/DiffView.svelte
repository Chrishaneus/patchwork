<script lang="ts">
	import type { TaskDiff } from '#lib/engine/contract.js';
	import { splitDiff } from '#lib/components/shared/format.js';
	import { m } from '#lib/paraglide/messages.js';

	let { diff }: { diff: TaskDiff } = $props();

	const files = $derived(splitDiff(diff.patch));
	const lineClass = (line: string) =>
		line.startsWith('+')
			? 'bg-green-500/10 text-green-800 dark:text-green-300'
			: line.startsWith('-')
				? 'bg-red-500/10 text-red-800 dark:text-red-300'
				: line.startsWith('@@')
					? 'text-sky-700 dark:text-sky-300'
					: '';
</script>

{#if files.length === 0}
	<p class="text-sm text-muted-foreground">{m.task_no_changes()}</p>
{:else}
	<div class="flex flex-col gap-3" data-testid="diff">
		{#if diff.truncated}
			<p class="text-sm text-muted-foreground">{m.task_diff_truncated()}</p>
		{/if}
		{#each files as file (file.path)}
			<details open class="overflow-hidden rounded-md border">
				<summary class="cursor-pointer bg-muted/50 px-3 py-2 font-mono text-xs">{file.path}</summary
				>
				<pre class="overflow-x-auto py-1 font-mono text-xs leading-5"><code
						>{#each file.lines as line, i (i)}<span class={['block px-3', lineClass(line)]}
								>{line || ' '}</span
							>{/each}</code
					></pre>
			</details>
		{/each}
	</div>
{/if}
