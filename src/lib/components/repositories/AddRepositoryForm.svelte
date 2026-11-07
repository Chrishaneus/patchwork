<script lang="ts">
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Lock from '@lucide/svelte/icons/lock';
	import Plus from '@lucide/svelte/icons/plus';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import FolderBrowserDialog from '#lib/components/repositories/FolderBrowserDialog.svelte';
	import type { EngineClient } from '#lib/engine/client.js';
	import type {
		EngineErrorCode,
		GitHubRepository,
		RepositoryCandidates
	} from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		onAdd,
		onAddUrl,
		pickDirectory,
		candidates,
		localPaths,
		githubRepos,
		addedUrls,
		client
	}: {
		/** Adds a local folder; resolves to an error code, or null on success. */
		onAdd: (path: string) => Promise<EngineErrorCode | null>;
		/** Clones a repository from a URL; resolves to an error code, or null on success. */
		onAddUrl: (url: string) => Promise<EngineErrorCode | null>;
		/** Native folder picker, when the host has one (desktop). */
		pickDirectory?: () => Promise<string | null>;
		/** Repositories the server found in its mounted folders. */
		candidates?: RepositoryCandidates;
		/** Whether local folders can be added here. */
		localPaths: boolean;
		/** The signed-in user's GitHub repositories; null when not signed in. */
		githubRepos: GitHubRepository[] | null;
		/** Remote URLs already added, so their Add buttons can be hidden. */
		addedUrls: string[];
		/** For the web folder browser (used when there's no native picker). */
		client: EngineClient;
	} = $props();

	// Where local folders are allowed (desktop, local mode, mounted folders) they come first.
	let tab = $state('');
	$effect.pre(() => {
		if (!tab) tab = localPaths ? 'local' : 'url';
	});
	let url = $state('');
	let path = $state('');
	let busy = $state<string | null>(null);
	let error = $state<EngineErrorCode | null>(null);
	let filter = $state('');

	async function run(
		key: string,
		action: () => Promise<EngineErrorCode | null>,
		onSuccess?: () => void
	) {
		busy = key;
		error = await action();
		busy = null;
		if (!error) onSuccess?.();
	}

	async function browse() {
		const picked = await pickDirectory?.();
		if (!picked) return;
		path = picked;
		await run(
			'path',
			() => onAdd(picked),
			() => (path = '')
		);
	}

	const shownRepos = $derived(
		(githubRepos ?? []).filter(
			(r) =>
				!addedUrls.includes(r.cloneUrl) &&
				r.fullName.toLowerCase().includes(filter.trim().toLowerCase())
		)
	);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>{m.repo_add_title()}</Card.Title>
	</Card.Header>
	<Card.Content>
		<Tabs.Root bind:value={tab} onValueChange={() => (error = null)}>
			<Tabs.List>
				<Tabs.Trigger value="url">{m.repo_add_tab_url()}</Tabs.Trigger>
				{#if localPaths}<Tabs.Trigger value="local">{m.repo_add_tab_local()}</Tabs.Trigger>{/if}
			</Tabs.List>

			<Tabs.Content value="url" class="flex flex-col gap-4 pt-2">
				<form
					class="flex flex-col gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						run(
							'url',
							() => onAddUrl(url),
							() => (url = '')
						);
					}}
				>
					<Label for="repo-url">{m.repo_url_label()}</Label>
					<div class="flex flex-col gap-2 sm:flex-row">
						<Input
							id="repo-url"
							class="font-mono"
							placeholder={m.repo_url_placeholder()}
							autocomplete="off"
							spellcheck={false}
							bind:value={url}
						/>
						<Button type="submit" disabled={busy !== null || !url.trim()}>
							{busy === 'url' ? m.repo_cloning() : m.repo_clone()}
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">{m.repo_url_hint()}</p>
				</form>

				{#if githubRepos}
					<div class="flex flex-col gap-2" data-testid="github-repositories">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="text-sm font-medium">{m.repo_github_title()}</p>
							<Input
								type="search"
								class="h-8 w-56"
								placeholder={m.repo_github_search()}
								aria-label={m.repo_github_search()}
								bind:value={filter}
							/>
						</div>
						{#if shownRepos.length === 0}
							<p class="text-sm text-muted-foreground">{m.repo_github_empty()}</p>
						{:else}
							<ScrollArea class="[&>[data-slot=scroll-area-viewport]]:max-h-72">
								<ul class="grid gap-2 pr-3 sm:grid-cols-2">
									{#each shownRepos as repo (repo.fullName)}
										<li class="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
											<span class="min-w-0">
												<span class="flex items-center gap-1.5 truncate text-sm font-medium">
													{repo.fullName}
													{#if repo.private}<Lock
															class="size-3 text-muted-foreground"
															aria-label={m.repo_private()}
														/>{/if}
												</span>
												{#if repo.description}
													<span class="block truncate text-xs text-muted-foreground"
														>{repo.description}</span
													>
												{/if}
											</span>
											<Button
												variant="outline"
												size="sm"
												disabled={busy !== null}
												aria-label={`${m.repo_add_submit()} ${repo.fullName}`}
												onclick={() => run(repo.fullName, () => onAddUrl(repo.cloneUrl))}
											>
												<Plus />{busy === repo.fullName ? m.repo_cloning() : m.repo_add_submit()}
											</Button>
										</li>
									{/each}
								</ul>
							</ScrollArea>
						{/if}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">{m.repo_github_signin_hint()}</p>
				{/if}
			</Tabs.Content>

			{#if localPaths}
				<Tabs.Content value="local" class="flex flex-col gap-4 pt-2">
					<form
						class="flex flex-col gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							run(
								'path',
								() => onAdd(path),
								() => (path = '')
							);
						}}
					>
						<Label for="repo-path">{m.repo_path_label()}</Label>
						<div class="flex flex-col gap-2 sm:flex-row">
							<Input
								id="repo-path"
								class="font-mono"
								placeholder={m.repo_path_placeholder()}
								autocomplete="off"
								spellcheck={false}
								bind:value={path}
							/>
							<div class="flex gap-2">
								{#if pickDirectory}
									<Button type="button" variant="outline" disabled={busy !== null} onclick={browse}>
										<FolderOpen />{m.repo_browse()}
									</Button>
								{:else}
									<FolderBrowserDialog {client} disabled={busy !== null} onPick={(p) => onAdd(p)} />
								{/if}
								<Button type="submit" disabled={busy !== null || !path.trim()}>
									{busy === 'path' ? m.repo_adding() : m.repo_add_submit()}
								</Button>
							</div>
						</div>
						<p class="text-xs text-muted-foreground">{m.repo_add_description()}</p>
					</form>
					{#if candidates}
						<div class="flex flex-col gap-2" data-testid="repository-candidates">
							<p class="text-sm font-medium">
								{m.repo_found_title({ roots: candidates.roots.join(', ') })}
							</p>
							{#if candidates.candidates.length === 0}
								<p class="text-sm text-muted-foreground">{m.repo_found_empty()}</p>
							{:else}
								<ul class="grid gap-2 sm:grid-cols-2">
									{#each candidates.candidates as candidate (candidate.path)}
										<li class="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
											<span class="min-w-0">
												<span class="block truncate text-sm font-medium">{candidate.name}</span>
												<span class="block truncate font-mono text-xs text-muted-foreground"
													>{candidate.path}</span
												>
											</span>
											<Button
												variant="outline"
												size="sm"
												disabled={busy !== null}
												aria-label={`${m.repo_add_submit()} ${candidate.name}`}
												onclick={() => run(candidate.path, () => onAdd(candidate.path))}
											>
												<Plus />{m.repo_add_submit()}
											</Button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
				</Tabs.Content>
			{/if}
		</Tabs.Root>
		{#if error}
			<p role="alert" class="mt-3 text-sm text-destructive">{engineErrorMessage(error)}</p>
		{/if}
	</Card.Content>
</Card.Root>
