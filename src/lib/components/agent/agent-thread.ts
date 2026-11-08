import type { LogEntry, Run, Task, TaskStatus } from '#lib/engine/contract.js';

/** `note`: something the agent said while still working, shown smaller than its reply. */
export type ThreadKind = 'user' | 'assistant' | 'note' | 'tool' | 'info' | 'error' | 'report';

export interface ThreadItem {
	key: string;
	kind: ThreadKind;
	text: string;
	at: string;
	/** Which repositories this item belongs to (names). */
	repos: string[];
	/** For `report`: the task whose review or exploration to show. */
	taskId?: string;
}

/** Reviews and explorations end with a JSON block for the app; the report card shows it instead. */
const stripJson = (text: string) => text.replace(/```json\s*[\s\S]*?```/gi, '').trim();

/** Follow-ups sent to several repositories at once are one message; their times differ slightly. */
const SAME_MESSAGE_MS = 10_000;

const ACTIVE: TaskStatus[] = ['queued', 'preparing', 'running'];

/**
 * Only a turn's last message is the agent's reply. Messages it wrote while still working ("the
 * install is still running…") become notes; agents don't mark them, so it shows only in what
 * follows: more work before your next message, or a task that's still running.
 */
function markProgressNotes(own: ThreadItem[], task: Task) {
	const turnEnds = (task.followUps ?? []).map((f) => Date.parse(f.at));
	const endOfTurn = (at: string) => turnEnds.find((end) => end > Date.parse(at)) ?? Infinity;
	own.forEach((item, index) => {
		if (item.kind !== 'assistant') return;
		const end = endOfTurn(item.at);
		const moreWork = own
			.slice(index + 1)
			.some(
				(next) => (next.kind === 'assistant' || next.kind === 'tool') && Date.parse(next.at) < end
			);
		const stillWorking = end === Infinity && ACTIVE.includes(task.status);
		if (moreWork || stillWorking) item.kind = 'note';
	});
}

/**
 * Turn a run into a chat thread: your messages (the first instruction and follow-ups), and the
 * agent's replies, tool calls, notes and errors, in time order. `taskId` limits it to one
 * repository.
 */
export function buildThread(
	run: Run,
	logs: Record<string, LogEntry[]>,
	taskId?: string
): ThreadItem[] {
	const tasks = taskId ? run.tasks.filter((t) => t.id === taskId) : run.tasks;
	const items: ThreadItem[] = [];

	items.push({
		key: 'instruction',
		kind: 'user',
		text: run.instruction,
		at: run.createdAt,
		repos: tasks.map((t) => t.repositoryName)
	});

	// Follow-ups: one message per text sent at (about) the same time, listing its repositories.
	for (const task of tasks) {
		for (const followUp of task.followUps ?? []) {
			const time = Date.parse(followUp.at);
			const existing = items.find(
				(i) =>
					i.kind === 'user' &&
					i.key !== 'instruction' &&
					i.text === followUp.instruction &&
					Math.abs(Date.parse(i.at) - time) < SAME_MESSAGE_MS
			);
			if (existing) existing.repos.push(task.repositoryName);
			else
				items.push({
					key: `follow-up:${task.id}:${followUp.at}`,
					kind: 'user',
					text: followUp.instruction,
					at: followUp.at,
					repos: [task.repositoryName]
				});
		}
	}

	// Read-only answers end with JSON; in a conversation that became a change, only the earlier ones.
	const readOnlyUntil =
		(run.kind ?? 'code') !== 'code'
			? Infinity
			: run.switchedFrom
				? Date.parse(run.switchedFrom.at)
				: -Infinity;
	for (const task of tasks) {
		const own: ThreadItem[] = [];
		(logs[task.id] ?? []).forEach((entry, index) => {
			// The follow-up note repeats a message that's already shown as yours.
			if (entry.kind === 'info' && entry.text.startsWith('Follow-up: ')) return;
			const kind = entry.kind === 'result' ? 'assistant' : entry.kind;
			const readOnly = Date.parse(entry.at) < readOnlyUntil;
			const text = readOnly && kind === 'assistant' ? stripJson(entry.text) : entry.text;
			if (!text) return;
			own.push({
				key: `${task.id}:${index}`,
				kind,
				text,
				at: entry.at,
				repos: [task.repositoryName]
			});
		});
		markProgressNotes(own, task);
		items.push(...own);
		// The latest report, where it was produced: when the task finished, or just before the
		// question being answered now.
		if (task.review || task.exploration) {
			// After a switch to a change, the report stays where the read-only part ended.
			const lastQuestion = run.switchedFrom?.at ?? task.followUps?.at(-1)?.at;
			const at =
				(!run.switchedFrom && task.finishedAt) ||
				(lastQuestion ? new Date(Date.parse(lastQuestion) - 1).toISOString() : run.createdAt);
			items.push({
				key: `report:${task.id}`,
				kind: 'report',
				text: '',
				at,
				repos: [task.repositoryName],
				taskId: task.id
			});
		}
	}

	// Time order; at the same moment your message comes first.
	return items
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				Date.parse(a.item.at) - Date.parse(b.item.at) ||
				(a.item.kind === 'user' ? -1 : 0) - (b.item.kind === 'user' ? -1 : 0) ||
				a.index - b.index
		)
		.map(({ item }) => item);
}
