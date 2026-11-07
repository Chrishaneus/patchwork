import type { EngineClient } from '#lib/engine/client.js';
import type { GitHubRepository } from '#lib/engine/contract.js';
import { m } from '#lib/paraglide/messages.js';
import type { RepositoriesState } from '#lib/app/repositories.svelte.js';

/** One pickable repository: a saved one, or a GitHub repository that isn't added yet. */
export interface RepositoryChoice {
	id: string;
	name: string;
	detail: string;
	/** Cloned when the run starts (not cloned yet, or straight from GitHub). */
	onFirstRun: boolean;
	/** Set for GitHub repositories that aren't added yet. */
	url?: string;
}

const GITHUB = 'github:';

/**
 * The repositories a change can run on (New change, Agent): saved ones that are usable, plus —
 * when signed in with GitHub — your GitHub repositories, added and cloned when the run starts.
 */
export class RepositoryChoices {
	githubRepos = $state<GitHubRepository[]>([]);

	constructor(
		private readonly repositories: RepositoriesState,
		private readonly client: EngineClient
	) {}

	async load() {
		await this.repositories.load();
		const settings = await this.client.getSettings({}).catch(() => null);
		if (settings?.githubAccount) {
			this.githubRepos = await this.client.listGitHubRepositories({}).catch(() => []);
		}
	}

	get loaded() {
		return this.repositories.loaded;
	}

	get available(): RepositoryChoice[] {
		const saved = this.repositories.items
			.filter((r) => r.status.available || (r.managed && r.cloneStatus !== 'ready'))
			.map((r) => ({
				id: r.id,
				name: r.name,
				detail: r.slug ?? r.path,
				onFirstRun: r.managed && r.cloneStatus !== 'ready'
			}));
		const added = Object.fromEntries(this.repositories.items.map((r) => [r.remoteUrl, true]));
		const fromGitHub = this.githubRepos
			.filter((r) => !added[r.cloneUrl])
			.map((r) => ({
				id: `${GITHUB}${r.fullName}`,
				name: r.fullName.split('/').pop() ?? r.fullName,
				detail: `${r.fullName} · ${m.new_change_from_github()}`,
				onFirstRun: true,
				url: r.cloneUrl
			}));
		return [...saved, ...fromGitHub];
	}

	/** Turn picked choices into repository ids, registering GitHub repositories first (not cloned). */
	async resolve(selected: string[]): Promise<string[]> {
		const fromGitHub = this.available.filter((c) => c.url && selected.includes(c.id));
		const newIds = await this.repositories.register(fromGitHub.map((c) => c.url!));
		return [...selected.filter((id) => !id.startsWith(GITHUB)), ...newIds];
	}

	/** Whether resolving these needs to register GitHub repositories first. */
	needsRegistering(selected: string[]) {
		return selected.some((id) => id.startsWith(GITHUB));
	}
}
