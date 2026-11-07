import { connectEngine, type EngineConnection } from '#lib/engine/client.js';
import { RepositoriesState } from '#lib/repositories.svelte.js';
import { RunsState } from '#lib/runs.svelte.js';

const TOKEN_KEY = 'patchwork.token';

function readToken(): string | undefined {
	try {
		// Saved under the old name before the rename to Patchwork.
		return localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem('ai-tool.token') ?? undefined;
	} catch {
		return undefined;
	}
}

function writeToken(token: string | null) {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// Storage can be unavailable (private mode); the token then lasts for this page only.
	}
}

/** The app's connection to the engine and the shared state built on it. */
class AppEngine {
	status = $state<'connecting' | 'ready' | 'unauthorized' | 'unavailable'>('connecting');
	connection = $state.raw<EngineConnection | null>(null);
	repositories = $state.raw<RepositoriesState | null>(null);
	runs = $state.raw<RunsState | null>(null);
	/** Set when the last access token was rejected. */
	tokenRejected = $state(false);

	async connect(token = readToken()) {
		this.status = 'connecting';
		const result = await connectEngine({ token });
		if (result.status === 'connected') {
			const { connection } = result;
			this.connection = connection;
			this.repositories = new RepositoriesState(connection.client, connection.events);
			this.runs = new RunsState(connection.client, connection.events);
			this.status = 'ready';
		} else {
			this.status = result.status;
		}
		return this.status;
	}

	/** Try an access token; keep it on this device if the server accepts it. */
	async login(token: string) {
		const status = await this.connect(token.trim());
		this.tokenRejected = status === 'unauthorized';
		if (status === 'ready') writeToken(token.trim());
		return status === 'ready';
	}

	logout() {
		writeToken(null);
		this.connection = null;
		this.repositories = null;
		this.runs = null;
		this.status = 'unauthorized';
	}
}

export const appEngine = new AppEngine();
if (typeof window !== 'undefined') void appEngine.connect();
