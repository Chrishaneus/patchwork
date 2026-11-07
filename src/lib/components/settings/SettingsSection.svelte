<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		id,
		title,
		description,
		children
	}: { id: string; title: string; description: string; children: Snippet } = $props();
</script>

<section class="grid gap-3" aria-labelledby={`${id}-heading`}>
	<div>
		<h2 id={`${id}-heading`} class="text-lg font-semibold tracking-tight">{title}</h2>
		<p class="text-sm text-muted-foreground">{description}</p>
	</div>
	{@render children()}
</section>
