import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LogEntry } from '#lib/engine/contract.js';

/** Append-only task logs, one JSON line per entry, so a crash keeps everything written so far. */
export class TaskLogs {
	constructor(private readonly dir: string) {}

	private file(taskId: string) {
		return path.join(this.dir, `${taskId}.jsonl`);
	}

	async append(taskId: string, entry: LogEntry) {
		await mkdir(this.dir, { recursive: true });
		await appendFile(this.file(taskId), `${JSON.stringify(entry)}\n`);
	}

	async read(taskId: string): Promise<LogEntry[]> {
		try {
			const text = await readFile(this.file(taskId), 'utf8');
			return text
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as LogEntry);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}

	async remove(taskId: string) {
		await rm(this.file(taskId), { force: true });
	}
}
