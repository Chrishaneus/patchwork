import type { EngineClient } from '#lib/engine/client.js';
import {
	EngineError,
	type EngineErrorCode,
	type EngineEventSource,
	type RepositoryWithStatus
} from '#lib/engine/contract.js';

const toCode = (error: unknown): EngineErrorCode =>
	error instanceof EngineError ? error.code : 'internal';

/** Reactive list of saved repositories, backed by the engine. */
export class RepositoriesState {
	items = $state<RepositoryWithStatus[]>([]);
	loaded = $state(false);
	loading = $state(false);
	/** Error from loading the list. */
	loadError = $state<EngineErrorCode | null>(null);
	/** Ids with a check or remove in progress. */
	busy = $state<Record<string, boolean>>({});

	constructor(
		private readonly client: EngineClient,
		events?: EngineEventSource
	) {
		// Clones started by runs update the list live.
		events?.((event) => {
			if (event.type !== 'repository.updated') return;
			const index = this.items.findIndex((r) => r.id === event.repository.id);
			if (index !== -1) this.items[index] = event.repository;
		});
	}

	/** Clone a repository added by URL now, instead of on its first run. */
	async clone(id: string) {
		await this.withBusy(id, async () => {
			const updated = await this.client.cloneRepository({ id });
			this.items = this.items.map((r) => (r.id === id ? updated : r));
		});
	}

	/** Register repositories by URL (not cloned yet) and return their ids, in order. */
	async register(urls: string[]): Promise<string[]> {
		const ids: string[] = [];
		for (const url of urls) {
			const repo = await this.client.addRepositoryFromUrl({ url });
			this.items = [...this.items, repo].sort((a, b) => a.name.localeCompare(b.name));
			ids.push(repo.id);
		}
		return ids;
	}

	async load() {
		this.loading = true;
		this.loadError = null;
		try {
			this.items = await this.client.listRepositories({});
			this.loaded = true;
		} catch (error) {
			this.loadError = toCode(error);
		} finally {
			this.loading = false;
		}
	}

	/** Add a folder. Resolves to an error code instead of throwing, for inline form errors. */
	async add(path: string): Promise<EngineErrorCode | null> {
		try {
			const repo = await this.client.addRepository({ path });
			this.items = [...this.items, repo].sort((a, b) => a.name.localeCompare(b.name));
			return null;
		} catch (error) {
			return toCode(error);
		}
	}

	/** Set or clear a repository's check command. Resolves to an error code, or null. */
	async setCheckCommand(id: string, checkCommand: string | null): Promise<EngineErrorCode | null> {
		try {
			const updated = await this.client.updateRepository({ id, checkCommand });
			this.items = this.items.map((r) => (r.id === id ? updated : r));
			return null;
		} catch (error) {
			return toCode(error);
		}
	}

	/** Clone a repository from a URL and add it. Resolves to an error code, or null. */
	async addFromUrl(url: string): Promise<EngineErrorCode | null> {
		try {
			const repo = await this.client.addRepositoryFromUrl({ url });
			this.items = [...this.items, repo].sort((a, b) => a.name.localeCompare(b.name));
			return null;
		} catch (error) {
			return toCode(error);
		}
	}

	async check(id: string) {
		await this.withBusy(id, async () => {
			const updated = await this.client.checkRepository({ id });
			this.items = this.items.map((r) => (r.id === id ? updated : r));
		});
	}

	async remove(id: string) {
		await this.withBusy(id, async () => {
			await this.client.removeRepository({ id });
			this.items = this.items.filter((r) => r.id !== id);
		});
	}

	private async withBusy(id: string, task: () => Promise<void>) {
		this.busy[id] = true;
		try {
			await task();
		} catch {
			// The repository may have been removed elsewhere; reload to resync.
			await this.load();
		} finally {
			delete this.busy[id];
		}
	}
}
