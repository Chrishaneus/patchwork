<script lang="ts">
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Plus from '@lucide/svelte/icons/plus';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import { EngineError, type EngineErrorCode, type FolderListing } from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';

	/** "Browse…" for the web app: pick a repository folder on the engine's machine. */
	let {
		client,
		disabled = false,
		onPick
	}: {
		client: EngineClient;
		disabled?: boolean;
		/** Called with the chosen repository folder; resolves to an error code, or null on success. */
		onPick: (path: string) => Promise<EngineErrorCode | null>;
	} = $props();

	let open = $state(false);
	let listing = $state<FolderListing | null>(null);
	let error = $state<EngineErrorCode | null>(null);
	let busy = $state(false);

	async function go(path?: string) {
		error = null;
		try {
			listing = await client.browseFolders(path === undefined ? {} : { path });
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
		}
	}

	async function pick(path: string) {
		busy = true;
		error = await onPick(path);
		busy = false;
		if (!error) open = false;
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (next) go();
	}}
>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} type="button" variant="outline" {disabled}
				><FolderOpen />{m.repo_browse()}</Button
			>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.folder_browse_title()}</Dialog.Title>
			<Dialog.Description>{m.folder_browse_description()}</Dialog.Description>
		</Dialog.Header>

		{#if listing}
			<div class="flex flex-wrap items-center gap-2">
				{#if listing.parent !== undefined}
					<Button
						variant="outline"
						size="sm"
						onclick={() => go(listing?.parent ?? undefined)}
						aria-label={m.folder_browse_up()}><ArrowUp />{m.folder_browse_up()}</Button
					>
				{/if}
				<code class="min-w-0 flex-1 truncate font-mono text-xs" data-testid="folder-path"
					>{listing.path ?? m.folder_browse_roots()}</code
				>
				{#if listing.path && listing.isGitRepository}
					<Button size="sm" disabled={busy} onclick={() => pick(listing!.path!)}>
						<Plus />{m.folder_browse_add_this()}
					</Button>
				{/if}
			</div>

			<ScrollArea class="rounded-md border [&>[data-slot=scroll-area-viewport]]:max-h-80">
				<ul class="pr-3" data-testid="folder-list">
					{#each listing.entries as entry (entry.path)}
						<li class="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
							<button
								type="button"
								class="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:underline"
								onclick={() => go(entry.path)}
							>
								{#if entry.isGitRepository}
									<FolderGit2 class="size-4 shrink-0 text-primary" />
								{:else}
									<Folder class="size-4 shrink-0 text-muted-foreground" />
								{/if}
								<span class="truncate">{entry.name}</span>
							</button>
							{#if entry.isGitRepository}
								<Badge variant="outline">{m.folder_browse_repo()}</Badge>
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									aria-label={`${m.repo_add_submit()} ${entry.name}`}
									onclick={() => pick(entry.path)}><Plus />{m.repo_add_submit()}</Button
								>
							{/if}
						</li>
					{:else}
						<li class="px-3 py-6 text-center text-sm text-muted-foreground">
							{m.folder_browse_empty()}
						</li>
					{/each}
				</ul>
			</ScrollArea>
			{#if listing.truncated}
				<p class="text-xs text-muted-foreground">{m.folder_browse_truncated()}</p>
			{/if}
		{/if}
		{#if error}<p role="alert" class="text-sm text-destructive">{engineErrorMessage(error)}</p>{/if}
	</Dialog.Content>
</Dialog.Root>
