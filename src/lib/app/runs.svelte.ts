import type { EngineClient } from '#lib/engine/client.js';
import {
	EngineError,
	type EngineErrorCode,
	type EngineEventSource,
	type LogEntry,
	type PublishInput,
	type Run,
	type Task,
	type TaskDiff
} from '#lib/engine/contract.js';

const toCode = (error: unknown): EngineErrorCode =>
	error instanceof EngineError ? error.code : 'internal';

/** Runs, task logs and diffs, kept live through engine events. */
export class RunsState {
	runs = $state<Run[]>([]);
	loaded = $state(false);
	loadError = $state<EngineErrorCode | null>(null);
	/** Logs of tasks that have been opened, by task id. */
	logs = $state<Record<string, LogEntry[]>>({});
	diffs = $state<Record<string, TaskDiff>>({});
	/** Error from the last action on a task, by task id. */
	actionErrors = $state<Record<string, EngineErrorCode>>({});

	constructor(
		private readonly client: EngineClient,
		events: EngineEventSource
	) {
		events((event) => {
			if (event.type === 'task.updated') this.applyTask(event.task);
			else if (event.type === 'task.log') this.logs[event.taskId]?.push(event.entry);
			else if (event.type === 'run.updated') this.applyRun(event.run);
			else void this.resync();
		});
	}

	get activeCount() {
		return this.runs
			.flatMap((r) => r.tasks)
			.filter((t) => ['queued', 'preparing', 'running'].includes(t.status)).length;
	}

	run(id: string): Run | undefined {
		return this.runs.find((r) => r.id === id);
	}

	async load() {
		try {
			this.runs = await this.client.listRuns({});
			this.loaded = true;
			this.loadError = null;
		} catch (error) {
			this.loadError = toCode(error);
		}
	}

	/** After a reconnect: reload runs and whatever logs and diffs are open. */
	async resync() {
		if (!this.loaded) return;
		await this.load();
		await Promise.all([
			...Object.keys(this.logs).map((id) => this.loadLog(id).catch(() => undefined)),
			...Object.keys(this.diffs).map((id) => this.loadDiff(id).catch(() => undefined))
		]);
	}

	async start(input: { repositoryIds: string[]; instruction: string; branch?: string }) {
		const run = await this.client.startRun(input);
		if (!this.run(run.id)) this.runs = [run, ...this.runs];
		return run;
	}

	/** Review a pull request (by link, or repository and number). */
	async startReview(input: Parameters<EngineClient['startReview']>[0]) {
		const run = await this.client.startReview(input);
		if (!this.run(run.id)) this.runs = [run, ...this.runs];
		return run;
	}

	/** Compare ways to build something, without changing any code. */
	async startExplore(input: { repositoryIds: string[]; idea: string }) {
		const run = await this.client.startExplore(input);
		if (!this.run(run.id)) this.runs = [run, ...this.runs];
		return run;
	}

	/** Ask a question about the code; the answer arrives in the conversation. */
	async startAsk(input: { repositoryIds: string[]; question: string }) {
		const run = await this.client.startAsk(input);
		if (!this.run(run.id)) this.runs = [run, ...this.runs];
		return run;
	}

	/** Post a finished review on GitHub or GitLab. */
	postReview(taskId: string) {
		return this.act(taskId, () => this.client.postReview({ taskId }));
	}

	async loadLog(taskId: string) {
		const live = this.logs[taskId] ?? [];
		const entries = await this.client.getTaskLog({ taskId });
		// Keep entries that arrived as events while the request was in flight.
		const key = (e: LogEntry) => `${e.at}|${e.text}`;
		const known = Object.fromEntries(entries.map((e) => [key(e), true]));
		this.logs[taskId] = [...entries, ...live.filter((e) => !known[key(e)])];
	}

	async loadDiff(taskId: string) {
		this.diffs[taskId] = await this.client.getTaskDiff({ taskId });
	}

	cancel(taskId: string) {
		return this.act(taskId, () => this.client.cancelTask({ taskId }));
	}

	discard(taskId: string) {
		return this.act(taskId, () => this.client.discardTask({ taskId }));
	}

	/** Send more instructions to the agent for this task. */
	followUp(taskId: string, instruction: string) {
		return this.act(taskId, () => this.client.followUpTask({ taskId, instruction }));
	}

	/** Turn a finished question or exploration into a change, in the same conversation. */
	async switchToChange(runId: string, instruction: string) {
		const run = this.run(runId);
		for (const task of run?.tasks ?? []) delete this.actionErrors[task.id];
		try {
			this.applyRun(await this.client.switchToChange({ runId, instruction }));
			return null;
		} catch (error) {
			return toCode(error);
		}
	}

	syncing = $state(false);

	/** Ask the providers for the latest PR states; updates arrive as task events. */
	async syncPullRequests() {
		this.syncing = true;
		try {
			await this.client.syncPullRequests({});
		} finally {
			this.syncing = false;
		}
	}

	runChecks(taskId: string) {
		return this.act(taskId, () => this.client.runChecks({ taskId }));
	}

	/** Commit, push and open the PR. Resolves to the task (published, or with `publishError`). */
	async publish(input: PublishInput): Promise<Task | null> {
		delete this.actionErrors[input.taskId];
		try {
			const task = await this.client.publishTask(input);
			this.applyTask(task);
			return task;
		} catch (error) {
			this.actionErrors[input.taskId] = toCode(error);
			return null;
		}
	}

	/** Open pull requests across all runs. */
	get openPullRequests() {
		return this.runs
			.flatMap((r) => r.tasks)
			.filter((t) => t.pullRequest && (t.pullRequest.state ?? 'open') === 'open').length;
	}

	private async act(taskId: string, action: () => Promise<Task>) {
		delete this.actionErrors[taskId];
		try {
			this.applyTask(await action());
		} catch (error) {
			this.actionErrors[taskId] = toCode(error);
		}
	}

	private applyRun(run: Run) {
		const index = this.runs.findIndex((r) => r.id === run.id);
		if (index === -1) this.runs = [run, ...this.runs];
		else this.runs[index] = run;
	}

	private applyTask(task: Task) {
		const run = this.run(task.runId);
		if (!run) {
			// A run started elsewhere (another window); fetch the list again.
			if (this.loaded) void this.load();
			return;
		}
		const index = run.tasks.findIndex((t) => t.id === task.id);
		if (index === -1) run.tasks.push(task);
		else run.tasks[index] = task;
		if (
			task.status === 'awaiting_review' ||
			task.status === 'cancelled' ||
			task.status === 'failed'
		) {
			if (this.diffs[task.id]) void this.loadDiff(task.id);
		}
	}
}
