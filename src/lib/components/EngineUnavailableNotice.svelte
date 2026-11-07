<script lang="ts">
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { m } from '#lib/paraglide/messages.js';
</script>

<Alert.Root>
	<MonitorSmartphone />
	<Alert.Title>{m.engine_unavailable_title()}</Alert.Title>
	<Alert.Description>{m.engine_unavailable_body()}</Alert.Description>
</Alert.Root>
