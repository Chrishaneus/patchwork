<script lang="ts">
	import { page } from '$app/state';
	import { ModeWatcher } from 'mode-watcher';
	import AppSidebar from '#lib/components/AppSidebar.svelte';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import { getLocale, getTextDirection } from '#lib/paraglide/runtime.js';
	import favicon from '#lib/assets/favicon.svg';
	import './layout.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// No server in the Capacitor/Electron builds, so keep <html lang/dir> in sync on the client.
	$effect(() => {
		void page.url;
		const locale = getLocale();
		document.documentElement.lang = locale;
		document.documentElement.dir = getTextDirection(locale);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- Dark by default; app.html applies the saved choice before the first paint. -->
<ModeWatcher defaultMode="dark" disableHeadScriptInjection />

<Sidebar.Provider>
	<AppSidebar />
	<Sidebar.Inset>
		<header class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
			<Sidebar.Trigger class="-ml-1" />
			<Separator
				orientation="vertical"
				class="mr-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
			/>
		</header>
		<main class="flex min-w-0 flex-1 flex-col gap-6 p-4 md:p-6">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
