import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LogEntry } from '#lib/engine/contract.js';

/** Entries of a task that couldn't be saved since the last one that was. */
interface Unsaved {
	count: number;
	reason: string;
	since: string;
}

/**
 * Append-only task logs, one JSON line per entry, so a crash keeps everything written so far.
 * Entries that can't be saved (a full disk) are counted, and the log says how many are missing
 * once saving works again.
 */
export class TaskLogs {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly unsaved = new Map<string, Unsaved>();

	constructor(private readonly dir: string) {}

	private file(taskId: string) {
		return path.join(this.dir, `${taskId}.jsonl`);
	}

	/**
	 * Saves an entry, in order with the others. Never rejects: `onFailure` hears about the first
	 * entry of a task that couldn't be saved, not every one after it.
	 */
	append(taskId: string, entry: LogEntry, onFailure?: (error: unknown) => void): Promise<void> {
		const next = this.queue.then(async () => {
			const gap = this.unsaved.get(taskId);
			try {
				await mkdir(this.dir, { recursive: true });
				const entries = gap ? [gapEntry(gap), entry] : [entry];
				// A failed write may have left half a line; start a new one.
				const text = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
				await appendFile(this.file(taskId), gap ? `\n${text}` : text);
				this.unsaved.delete(taskId);
			} catch (error) {
				if (gap) {
					gap.count++;
					return;
				}
				this.unsaved.set(taskId, { count: 1, reason: messageOf(error), since: entry.at });
				onFailure?.(error);
			}
		});
		this.queue = next;
		return next;
	}

	async read(taskId: string): Promise<LogEntry[]> {
		await this.queue;
		let text: string;
		try {
			text = await readFile(this.file(taskId), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			text = '';
		}
		const entries = text.split('\n').flatMap((line) => {
			try {
				return line ? [JSON.parse(line) as LogEntry] : [];
			} catch {
				return [];
			}
		});
		const gap = this.unsaved.get(taskId);
		return gap ? [...entries, gapEntry(gap)] : entries;
	}

	async remove(taskId: string) {
		this.unsaved.delete(taskId);
		await rm(this.file(taskId), { force: true });
	}
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function gapEntry(gap: Unsaved): LogEntry {
	const entries = gap.count === 1 ? '1 entry' : `${gap.count} entries`;
	return {
		at: gap.since,
		kind: 'error',
		text: `${entries} of this log couldn't be saved and ${gap.count === 1 ? 'is' : 'are'} missing here: ${gap.reason}`
	};
}
