<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Path } from '$app/types';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import EngineGate from '#lib/components/app/EngineGate.svelte';
	import RunDetail from '#lib/components/runs/RunDetail.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { m } from '#lib/paraglide/messages.js';
	import { localizeHref } from '#lib/paraglide/runtime.js';
</script>

<div>
	<Button variant="ghost" size="sm" class="-ml-2" href={resolve(localizeHref('/runs') as Path)}>
		<ArrowLeft />{m.run_detail_back()}
	</Button>
</div>

<EngineGate>
	{#snippet children({ runs, repositories })}
		<RunDetail {runs} {repositories} runId={page.params.id ?? ''} />
	{/snippet}
</EngineGate>
