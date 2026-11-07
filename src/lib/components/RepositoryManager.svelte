<script lang="ts">
	import { onMount } from 'svelte';
	import AddRepositoryForm from '#lib/components/AddRepositoryForm.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import RepositoryCard from '#lib/components/RepositoryCard.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { EngineConnection } from '#lib/engine/client.js';
	import type { EngineInfo, GitHubRepository, RepositoryCandidates } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { RepositoriesState } from '#lib/repositories.svelte.js';

	let {
		repositories,
		connection
	}: { repositories: RepositoriesState; connection: EngineConnection } = $props();

	let candidates = $state<RepositoryCandidates | null>(null);
	let info = $state<EngineInfo | null>(null);
	let githubRepos = $state<GitHubRepository[] | null>(null);

	async function loadGitHubRepos() {
		const settings = await connection.client.getSettings({}).catch(() => null);
		githubRepos = settings?.githubAccount
			? await connection.client.listGitHubRepositories({}).catch(() => null)
			: null;
	}

	async function loadCandidates() {
		candidates = await connection.client.listRepositoryCandidates({}).catch(() => null);
	}

	onMount(() => {
		repositories.load();
		loadCandidates();
		loadGitHubRepos();
		connection.client.getEngineInfo({}).then((i) => (info = i));
	});

	async function add(path: string) {
		const error = await repositories.add(path);
		if (!error) void loadCandidates();
		return error;
	}

	async function remove(id: string) {
		await repositories.remove(id);
		void loadCandidates();
	}
</script>

{#if info}
	<AddRepositoryForm
		onAdd={add}
		onAddUrl={(url) => repositories.addFromUrl(url)}
		pickDirectory={connection.host.pickDirectory}
		candidates={candidates?.roots.length ? candidates : undefined}
		localPaths={info.localPaths}
		{githubRepos}
		addedUrls={repositories.items.filter((r) => r.managed).map((r) => r.remoteUrl)}
		client={connection.client}
	/>
{/if}

{#if repositories.loadError}
	<div class="flex items-center gap-3 text-sm text-destructive" role="alert">
		{m.repo_load_failed()}
		<Button variant="outline" size="sm" onclick={() => repositories.load()}>{m.retry()}</Button>
	</div>
{:else if repositories.loaded && repositories.items.length === 0}
	<EmptyState message={m.repositories_empty()} />
{:else}
	<div class="grid gap-4" aria-live="polite">
		{#each repositories.items as repo (repo.id)}
			<RepositoryCard
				{repo}
				busy={repositories.busy[repo.id]}
				onCheck={() => repositories.check(repo.id)}
				onRemove={() => remove(repo.id)}
				onSetCheckCommand={(command) => repositories.setCheckCommand(repo.id, command)}
				onClone={() => repositories.clone(repo.id)}
			/>
		{/each}
	</div>
{/if}
