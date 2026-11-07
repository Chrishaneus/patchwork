<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import type { TaskChecks } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let { checks }: { checks: TaskChecks | null | undefined } = $props();
</script>

{#if checks?.status === 'passed'}
	<Badge variant="outline" class="text-green-700 dark:text-green-400" data-checks="passed"
		><CircleCheck />{m.checks_passed()}</Badge
	>
{:else if checks?.status === 'failed'}
	<Badge variant="destructive" data-checks="failed"><CircleX />{m.checks_failed()}</Badge>
{:else if checks?.status === 'running'}
	<Badge variant="secondary" data-checks="running"
		><LoaderCircle class="animate-spin" />{m.checks_running()}</Badge
	>
{:else}
	<Badge variant="outline" class="text-muted-foreground" data-checks="none">{m.checks_none()}</Badge
	>
{/if}
