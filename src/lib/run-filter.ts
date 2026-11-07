import { activeTaskStatuses, type Run } from '#lib/engine/contract.js';

export type RunFilter = 'all' | 'active' | 'review' | 'published' | 'failed';

/** Whether a run matches the status filter: any of its tasks is in that state. */
export function matchesFilter(run: Run, filter: RunFilter): boolean {
	if (filter === 'all') return true;
	return run.tasks.some((t) =>
		filter === 'active'
			? activeTaskStatuses.includes(t.status)
			: filter === 'review'
				? t.status === 'awaiting_review'
				: filter === 'published'
					? t.status === 'published'
					: t.status === 'failed'
	);
}

/** Case-insensitive search over the instruction, follow-ups, repository names and branches. */
export function matchesSearch(run: Run, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const haystack = [
		run.instruction,
		...run.tasks.flatMap((t) => [
			t.repositoryName,
			t.branch,
			...(t.followUps ?? []).map((f) => f.instruction)
		])
	];
	return haystack.some((text) => text.toLowerCase().includes(q));
}
