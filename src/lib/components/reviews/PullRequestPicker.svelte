<script lang="ts">
	import * as Select from '#lib/components/ui/select/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { EngineClient } from '#lib/engine/client.js';
	import {
		EngineError,
		type EngineErrorCode,
		type PullRequestSummary,
		type Repository
	} from '#lib/engine/contract.js';
	import { engineErrorMessage } from '#lib/engine/errors.js';
	import { m } from '#lib/paraglide/messages.js';

	/** Pick a repository on GitHub or GitLab, then one of its open pull requests. */
	let {
		client,
		repositories,
		repositoryId = $bindable(''),
		pullNumber = $bindable('')
	}: {
		client: EngineClient;
		repositories: Repository[];
		repositoryId?: string;
		pullNumber?: string;
	} = $props();

	let pulls = $state<PullRequestSummary[] | null>(null);
	let error = $state<EngineErrorCode | null>(null);

	// Only repositories on GitHub or GitLab have pull requests.
	const hosted = $derived(
		repositories.filter((r) => (r.provider === 'github' || r.provider === 'gitlab') && r.slug)
	);
	const repository = $derived(hosted.find((r) => r.id === repositoryId));
	const pull = $derived(pulls?.find((p) => String(p.number) === pullNumber));

	async function load(id: string) {
		pulls = null;
		error = null;
		pullNumber = '';
		try {
			pulls = await client.listPullRequests({ repositoryId: id });
		} catch (e) {
			error = e instanceof EngineError ? e.code : 'internal';
		}
	}
</script>

{#if hosted.length === 0}
	<p class="text-sm text-muted-foreground">{m.review_no_hosted_repos()}</p>
{:else}
	<div class="flex min-w-0 flex-col gap-3">
		<div class="flex flex-col gap-1.5">
			<Label>{m.review_repository_label()}</Label>
			<Select.Root type="single" bind:value={repositoryId} onValueChange={(id) => id && load(id)}>
				<Select.Trigger class="w-full" aria-label={m.review_repository_label()}>
					<span class="truncate">{repository?.slug ?? m.review_repository_placeholder()}</span>
				</Select.Trigger>
				<Select.Content>
					{#each hosted as repo (repo.id)}
						<Select.Item value={repo.id} label={repo.slug ?? repo.name} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		{#if repositoryId}
			<div class="flex flex-col gap-1.5">
				<Label>{m.review_pull_label()}</Label>
				{#if error}
					<p role="alert" class="text-sm text-destructive">{engineErrorMessage(error)}</p>
				{:else if pulls === null}
					<p class="text-sm text-muted-foreground">{m.review_pulls_loading()}</p>
				{:else if pulls.length === 0}
					<p class="text-sm text-muted-foreground">{m.review_pulls_empty()}</p>
				{:else}
					<Select.Root type="single" bind:value={pullNumber}>
						<Select.Trigger class="w-full" aria-label={m.review_pull_label()}>
							<span class="truncate"
								>{pull ? `#${pull.number} ${pull.title}` : m.review_pull_placeholder()}</span
							>
						</Select.Trigger>
						<Select.Content>
							{#each pulls as p (p.number)}
								<Select.Item value={String(p.number)} label={`#${p.number} ${p.title}`}>
									<span class="flex min-w-0 flex-col">
										<span class="truncate">#{p.number} {p.title}</span>
										<span class="truncate font-mono text-xs text-muted-foreground"
											>{p.headRef} → {p.baseRef}{p.author ? ` · ${p.author}` : ''}</span
										>
									</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{/if}
			</div>
		{/if}
	</div>
{/if}
