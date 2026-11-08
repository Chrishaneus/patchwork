<script lang="ts">
	import DatabaseBackup from '@lucide/svelte/icons/database-backup';
	import X from '@lucide/svelte/icons/x';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { DataRecovery } from '#lib/engine/contract.js';
	import { m } from '#lib/paraglide/messages.js';

	let { recovery, onDismiss }: { recovery: DataRecovery; onDismiss: () => void } = $props();
</script>

<Alert.Root data-testid="data-recovery">
	<DatabaseBackup />
	<Alert.Title>{m.data_recovery_title()}</Alert.Title>
	<Alert.Description>
		<p>
			{recovery.kind === 'restored'
				? m.data_recovery_restored()
				: recovery.kind === 'reset'
					? m.data_recovery_reset()
					: m.data_recovery_partial({ count: recovery.skipped })}
		</p>
		{#if recovery.movedTo}
			<p class="break-all">{m.data_recovery_kept({ path: recovery.movedTo })}</p>
		{/if}
	</Alert.Description>
	<Alert.Action>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={m.data_recovery_dismiss()}
			onclick={onDismiss}
		>
			<X />
		</Button>
	</Alert.Action>
</Alert.Root>
