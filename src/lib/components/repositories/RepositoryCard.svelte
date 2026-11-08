<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Download from '@lucide/svelte/icons/download';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import CheckCommandEditor from '#lib/components/repositories/CheckCommandEditor.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type { EngineErrorCode, RepositoryWithStatus } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let {
		repo,
		busy = false,
		onCheck,
		onRemove,
		onSetCheckCommand,
		onDisallowProgram,
		onClone
	}: {
		repo: RepositoryWithStatus;
		busy?: boolean;
		onCheck: () => void;
		onRemove: () => void;
		onSetCheckCommand: (command: string | null) => Promise<EngineErrorCode | null>;
		onDisallowProgram: (program: string) => Promise<EngineErrorCode | null>;
		onClone: () => void;
	} = $props();

	const providerLabel = {
		github: 'GitHub',
		gitlab: 'GitLab',
		bitbucket: 'Bitbucket',
		other: 'Git'
	};
</script>

<Card.Root aria-busy={busy} data-testid="repository">
	<Card.Header>
		<Card.Title class="flex flex-wrap items-center gap-2">
			<span>{repo.name}</span>
			<Badge variant="outline">{providerLabel[repo.provider]}</Badge>
			{#if repo.managed}
				<Badge variant="secondary">{m.repo_managed()}</Badge>
			{/if}
			{#if repo.slug}
				<span class="text-sm font-normal text-muted-foreground">{repo.slug}</span>
			{/if}
		</Card.Title>
		<Card.Description class="font-mono text-xs break-all">{repo.path}</Card.Description>
		<Card.Action class="flex gap-1">
			<Button
				variant="ghost"
				size="icon"
				disabled={busy}
				onclick={onCheck}
				aria-label={m.repo_check()}
				title={m.repo_check()}
			>
				<RefreshCw class={busy ? 'animate-spin' : ''} />
			</Button>
			<AlertDialog.Root>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							disabled={busy}
							aria-label={m.repo_remove()}
							title={m.repo_remove()}
						>
							<Trash2 />
						</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>{m.repo_remove_title({ name: repo.name })}</AlertDialog.Title>
						<AlertDialog.Description
							>{repo.managed
								? m.repo_remove_body_managed()
								: m.repo_remove_body()}</AlertDialog.Description
						>
					</AlertDialog.Header>
					<AlertDialog.Footer>
						<AlertDialog.Cancel>{m.repo_remove_cancel()}</AlertDialog.Cancel>
						<AlertDialog.Action onclick={onRemove}>{m.repo_remove()}</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex-row flex-wrap gap-2 text-sm">
		{#if repo.cloneStatus && repo.cloneStatus !== 'ready'}
			<div
				class="flex w-full flex-wrap items-center gap-2"
				data-testid="clone-status"
				data-clone-status={repo.cloneStatus}
			>
				{#if repo.cloneStatus === 'cloning'}
					<Badge variant="secondary"
						><LoaderCircle class="animate-spin" />{m.repo_cloning_now()}</Badge
					>
				{:else if repo.cloneStatus === 'failed'}
					<Badge variant="destructive"><CircleAlert />{m.repo_clone_failed()}</Badge>
				{:else}
					<Badge variant="outline">{m.repo_clone_pending()}</Badge>
					<span class="text-xs text-muted-foreground">{m.repo_clone_pending_hint()}</span>
				{/if}
				{#if repo.cloneStatus !== 'cloning'}
					<Button variant="outline" size="sm" disabled={busy} onclick={onClone}
						><Download />{m.repo_clone_now()}</Button
					>
				{/if}
				{#if repo.cloneStatus === 'failed' && repo.cloneError}
					<p class="w-full font-mono text-xs break-all text-muted-foreground">{repo.cloneError}</p>
				{/if}
			</div>
		{:else if repo.status.available}
			<Badge variant="secondary">
				<GitBranch />{m.repo_current_branch({ branch: repo.status.currentBranch ?? '—' })}
			</Badge>
			<Badge variant="outline">{m.repo_default_branch({ branch: repo.defaultBranch })}</Badge>
			<Badge variant="outline">
				{repo.status.uncommittedChanges === 0
					? m.repo_clean()
					: m.repo_uncommitted({ count: repo.status.uncommittedChanges })}
			</Badge>
		{:else}
			<Badge variant="destructive"><CircleAlert />{m.repo_unavailable()}</Badge>
		{/if}
		<CheckCommandEditor repoId={repo.id} command={repo.checkCommand} onSave={onSetCheckCommand} />
		{#if repo.allowedPrograms?.length}
			<div class="flex w-full flex-wrap items-center gap-2" data-testid="allowed-programs">
				<span class="text-xs text-muted-foreground">{m.repo_allowed_programs()}</span>
				{#each repo.allowedPrograms as program (program)}
					<Badge variant="outline" class="gap-1 pr-0.5 font-mono">
						{program}
						<Button
							variant="ghost"
							size="icon"
							class="size-5"
							disabled={busy}
							onclick={() => onDisallowProgram(program)}
							aria-label={m.repo_disallow_program({ program })}
							title={m.repo_disallow_program({ program })}
						>
							<X class="size-3" />
						</Button>
					</Badge>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
