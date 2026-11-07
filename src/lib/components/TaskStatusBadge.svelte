<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import type { TaskStatus } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let { status }: { status: TaskStatus } = $props();

	const labels: Record<TaskStatus, () => string> = {
		queued: m.task_status_queued,
		preparing: m.task_status_preparing,
		running: m.task_status_running,
		checking: m.task_status_checking,
		awaiting_review: m.task_status_awaiting_review,
		publishing: m.task_status_publishing,
		published: m.task_status_published,
		failed: m.task_status_failed,
		cancelled: m.task_status_cancelled,
		discarded: m.task_status_discarded,
		completed: m.task_status_completed
	};
	const variant = $derived(
		status === 'failed'
			? 'destructive'
			: status === 'awaiting_review' || status === 'published' || status === 'completed'
				? 'default'
				: ['running', 'preparing', 'checking', 'publishing'].includes(status)
					? 'secondary'
					: 'outline'
	);
	const busy = $derived(['running', 'preparing', 'checking', 'publishing'].includes(status));
</script>

<Badge {variant} data-status={status}>
	{#if busy}<LoaderCircle class="animate-spin" />{/if}
	{labels[status]()}
</Badge>
