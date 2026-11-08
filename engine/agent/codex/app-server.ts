import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** The parts of Codex's app-server protocol the runner uses (`codex app-server generate-ts`). */
export type CodexItem =
	| { type: 'agentMessage'; id: string; text: string; phase?: string | null }
	| { type: 'commandExecution'; id: string; command: string; status: string }
	| {
			type: 'fileChange';
			id: string;
			changes: { path: string; kind: { type: 'add' | 'delete' | 'update' } }[];
			status: string;
	  }
	| { type: 'webSearch'; id: string; query: string }
	| { type: 'mcpToolCall'; id: string; server: string; tool: string }
	| { type: string; id: string };

export interface CodexTurn {
	id: string;
	status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
	error: { message: string; additionalDetails?: string | null } | null;
}

export interface AppServerOptions {
	executable: string;
	args: string[];
	env: Record<string, string>;
	onNotification: (method: string, params: Record<string, unknown>) => void;
	/** Answers the server's requests, such as approvals; throwing sends back an error. */
	onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	/** The process ended; `error` says why when it wasn't closed by us. */
	onExit: (error: Error) => void;
}

/**
 * A `codex app-server` process, spoken to in JSON-RPC over stdio (one JSON message per line).
 * Unlike `codex exec`, it asks its client before running a command outside the sandbox.
 */
export function startAppServer(opts: AppServerOptions) {
	const child = spawn(opts.executable, ['app-server', ...opts.args], {
		env: opts.env,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	});
	let nextId = 1;
	let closed = false;
	let stderr = '';
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	const send = (message: object) => {
		if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	child.stderr.on('data', (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-4000);
	});
	child.stdin.on('error', () => {});
	readline.createInterface({ input: child.stdout }).on('line', (line) => {
		let message: {
			id?: number | string;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { message?: string };
		};
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.method === undefined && typeof message.id === 'number') {
			const call = pending.get(message.id);
			pending.delete(message.id);
			if (message.error)
				call?.reject(new Error(message.error.message ?? 'Codex refused a request.'));
			else call?.resolve(message.result);
		} else if (message.method !== undefined && message.id !== undefined) {
			const id = message.id;
			opts.onRequest(message.method, message.params ?? {}).then(
				(result) => send({ id, result }),
				(error: Error) => send({ id, error: { code: -32601, message: error.message } })
			);
		} else if (message.method !== undefined) {
			opts.onNotification(message.method, message.params ?? {});
		}
	});

	const ended = (error: Error) => {
		for (const call of pending.values()) call.reject(error);
		pending.clear();
		if (!closed) opts.onExit(error);
		closed = true;
	};
	child.on('error', ended);
	child.on('exit', (code, signal) => {
		const detail = stderr
			.split('\n')
			.filter((line) => line.trim() && !line.startsWith('WARNING:'))
			.slice(-5)
			.join('\n');
		ended(new Error(detail || `Codex stopped (${signal ?? `exit code ${code}`}).`));
	});

	return {
		request<T>(method: string, params: object): Promise<T> {
			if (closed) return Promise.reject(new Error('Codex isn’t running.'));
			const id = nextId++;
			return new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
				send({ id, method, params });
			});
		},
		notify(method: string, params?: object) {
			send(params ? { method, params } : { method });
		},
		close() {
			if (closed) return;
			closed = true;
			for (const call of pending.values()) call.reject(new Error('Codex was stopped.'));
			pending.clear();
			child.kill();
		}
	};
}
