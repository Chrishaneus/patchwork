import { activeTaskStatuses, type Task } from '#lib/engine/contract.js';
import type { EngineEvents } from '../core/events.js';
import type { JsonStore } from '../core/store.js';

/** Tasks that were working when the app last quit can't resume; mark them interrupted. */
export async function recoverInterrupted(store: JsonStore, events: EngineEvents) {
	const { runs } = await store.read();
	const anyActive = runs.some((run) =>
		run.tasks.some((t) => activeTaskStatuses.includes(t.status))
	);
	if (!anyActive) return;
	const interrupted: Task[] = [];
	await store.update((data) => {
		for (const run of data.runs) {
			run.tasks = run.tasks.map((task) => {
				if (!activeTaskStatuses.includes(task.status)) return task;
				if (task.status === 'checking' && task.finishedAt) {
					// Checks were re-run on a reviewed change: back to review.
					const back: Task = {
						...task,
						status: 'awaiting_review',
						checks: task.checks && {
							...task.checks,
							status: 'failed',
							output: `${task.checks.output}\n(interrupted)`.trim()
						}
					};
					interrupted.push(back);
					return back;
				}
				if (task.status === 'publishing') {
					const back: Task = {
						...task,
						status: 'awaiting_review',
						publishError: {
							code: 'interrupted',
							message: 'The app closed while publishing. Publish again to finish.'
						}
					};
					interrupted.push(back);
					return back;
				}
				const updated: Task = {
					...task,
					status: 'failed',
					finishedAt: new Date().toISOString(),
					approval: null,
					error: { code: 'interrupted', message: 'The app closed while this task was running.' }
				};
				interrupted.push(updated);
				return updated;
			});
		}
	});
	for (const task of interrupted) events.emit({ type: 'task.updated', task });
}
