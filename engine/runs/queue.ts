export type StopReason = 'cancelled' | 'timeout';

/** How a task in the queue (or running) is stopped, and why it was. */
export interface TaskHandle {
	controller: AbortController;
	reason?: StopReason;
}

/**
 * Runs queued tasks, at most `concurrency` at a time. Every queued or running task has a handle,
 * so it can be cancelled; `register` gives one to work that runs outside the queue (checks).
 */
export function createTaskQueue(
	execute: (taskId: string, handle: TaskHandle) => Promise<void>,
	initialConcurrency: number
) {
	const handles = new Map<string, TaskHandle>();
	const waiting: string[] = [];
	let running = 0;
	let concurrency = initialConcurrency;

	function pump() {
		while (running < concurrency && waiting.length > 0) {
			const taskId = waiting.shift()!;
			const handle = handles.get(taskId);
			if (!handle || handle.controller.signal.aborted) continue;
			running += 1;
			execute(taskId, handle).finally(() => {
				release(taskId, handle);
				running -= 1;
				pump();
			});
		}
	}

	function register(taskId: string): TaskHandle {
		const handle: TaskHandle = { controller: new AbortController() };
		handles.set(taskId, handle);
		return handle;
	}

	/** Forget a handle, unless the task has a newer one by now (a follow-up was queued). */
	function release(taskId: string, handle: TaskHandle) {
		if (handles.get(taskId) === handle) handles.delete(taskId);
	}

	return {
		enqueue(taskIds: string[]) {
			for (const taskId of taskIds) {
				register(taskId);
				waiting.push(taskId);
			}
			pump();
		},
		register,
		release,
		handle: (taskId: string) => handles.get(taskId),
		/** Take a task that hasn't started out of the queue. Returns whether it was waiting. */
		remove(taskId: string) {
			const index = waiting.indexOf(taskId);
			if (index === -1) return false;
			waiting.splice(index, 1);
			handles.delete(taskId);
			return true;
		},
		setConcurrency(value: number) {
			concurrency = value;
			pump();
		}
	};
}

/** Stop the task after `minutes`; returns a function that clears the limit. */
export function startTimeLimit(handle: TaskHandle, minutes: number) {
	const timer = setTimeout(() => {
		handle.reason = 'timeout';
		handle.controller.abort();
	}, minutes * 60_000);
	return () => clearTimeout(timer);
}
