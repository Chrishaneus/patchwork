import {
	EngineError,
	engineMethods,
	type EngineInput,
	type EngineMethod,
	type EngineOutput,
	type EngineEvent,
	type EngineEventSource,
	type EngineTransport,
	type HostCapabilities
} from './contract';

/** Typed engine calls. Rejects with `EngineError` (with a stable `code`) when a call fails. */
export type EngineClient = {
	[M in EngineMethod]: (input: EngineInput<M>) => Promise<EngineOutput<M>>;
};

/** Build a typed client on top of any transport (Electron IPC today, HTTP for web/mobile next). */
export function createEngineClient(transport: EngineTransport): EngineClient {
	const client: Partial<Record<EngineMethod, (input: unknown) => Promise<unknown>>> = {};
	for (const method of engineMethods) {
		client[method] = async (input) => {
			// Send plain JSON: UI state (e.g. Svelte proxies) can't cross IPC or HTTP as-is.
			const plain = input === undefined ? undefined : JSON.parse(JSON.stringify(input));
			const result = await transport(method, plain);
			if (!result.ok) throw new EngineError(result.error.code, result.error.message);
			return result.value;
		};
	}
	return client as EngineClient;
}

export interface EngineConnection {
	/** Where the engine runs: inside the desktop app, or on a server reached over HTTP. */
	kind: 'desktop' | 'server';
	client: EngineClient;
	/** Live task updates and log lines. */
	events: EngineEventSource;
	host: HostCapabilities;
}

export type ConnectResult =
	| { status: 'connected'; connection: EngineConnection }
	/** The server needs an access token (missing or wrong). */
	| { status: 'unauthorized' }
	/** No engine here: the plain static build, or the native apps until they can pick a server. */
	| { status: 'unavailable' };

const authHeaders = (token?: string): Record<string, string> =>
	token ? { authorization: `Bearer ${token}` } : {};

/** Engine calls over HTTP: `POST {baseUrl}/api/engine/:method` with a JSON body. */
export function createHttpTransport(baseUrl: string, token?: string): EngineTransport {
	return async (method, input) => {
		const res = await fetch(`${baseUrl}/api/engine/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input ?? {})
		});
		if (res.status === 401)
			return { ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } };
		if (!res.ok) return { ok: false, error: { code: 'internal', message: `HTTP ${res.status}` } };
		return res.json();
	};
}

/**
 * Live events over server-sent events (`GET {baseUrl}/api/events`), read with fetch so the access
 * token can go in a header. Reconnects with backoff and sends a `resync` event after reconnecting.
 */
export function createHttpEventSource(baseUrl: string, token?: string): EngineEventSource {
	const listeners = new Set<(event: EngineEvent) => void>();
	let started = false;
	const emit = (event: EngineEvent) => listeners.forEach((l) => l(event));

	async function connectLoop() {
		let attempt = 0;
		for (;;) {
			try {
				const res = await fetch(`${baseUrl}/api/events`, { headers: authHeaders(token) });
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				if (attempt > 0) emit({ type: 'resync' });
				attempt = 0;
				const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
				let buffer = '';
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += value;
					const parts = buffer.split('\n\n');
					buffer = parts.pop() ?? '';
					for (const part of parts) {
						if (part.startsWith('data: ')) emit(JSON.parse(part.slice(6)) as EngineEvent);
					}
				}
			} catch {
				// Connection lost or refused; retry below.
			}
			attempt += 1;
			await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 15_000)));
		}
	}

	return (listener) => {
		listeners.add(listener);
		if (!started) {
			started = true;
			void connectLoop();
		}
		return () => listeners.delete(listener);
	};
}

const isNativeApp = () =>
	typeof window !== 'undefined' &&
	!!(
		window as { Capacitor?: { isNativePlatform?: () => boolean } }
	).Capacitor?.isNativePlatform?.();

/**
 * Connect to the engine available here: the desktop app's own engine, else the server this page
 * was loaded from.
 */
export async function connectEngine(
	opts: { token?: string; baseUrl?: string } = {}
): Promise<ConnectResult> {
	if (typeof window === 'undefined') return { status: 'unavailable' };

	if (window.electron) {
		const bridge = window.electron;
		return {
			status: 'connected',
			connection: {
				kind: 'desktop',
				client: createEngineClient(bridge.engine.invoke),
				events: bridge.engine.onEvent,
				host: { pickDirectory: bridge.host.pickDirectory }
			}
		};
	}

	// Native apps will connect to a server the user chooses (planned).
	if (isNativeApp() && !opts.baseUrl) return { status: 'unavailable' };

	const baseUrl = opts.baseUrl ?? '';
	try {
		const res = await fetch(`${baseUrl}/api/health`, { headers: authHeaders(opts.token) });
		const health = (await res.json()) as { ok?: boolean; auth?: boolean; authorized?: boolean };
		if (!health.ok) return { status: 'unavailable' };
		if (health.auth && !health.authorized) return { status: 'unauthorized' };
	} catch {
		// A static host without the API answers with HTML or 404: no engine.
		return { status: 'unavailable' };
	}

	return {
		status: 'connected',
		connection: {
			kind: 'server',
			client: createEngineClient(createHttpTransport(baseUrl, opts.token)),
			events: createHttpEventSource(baseUrl, opts.token),
			host: {}
		}
	};
}
