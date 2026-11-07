<script lang="ts">
	import Monitor from '@lucide/svelte/icons/monitor';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import type { Component } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';

	type Choice = 'light' | 'dark' | 'system';
	const choices: { value: Choice; label: () => string; icon: Component }[] = [
		{ value: 'light', label: m.theme_light, icon: Sun },
		{ value: 'dark', label: m.theme_dark, icon: Moon },
		{ value: 'system', label: m.theme_system, icon: Monitor }
	];
</script>

<div class="flex items-center gap-0.5" role="group" aria-label={m.theme_label()}>
	{#each choices as choice (choice.value)}
		{@const Icon = choice.icon}
		<button
			type="button"
			class="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground [&_svg]:size-3.5"
			aria-pressed={userPrefersMode.current === choice.value}
			aria-label={choice.label()}
			title={choice.label()}
			onclick={() => setMode(choice.value)}
		>
			<Icon />
		</button>
	{/each}
</div>
