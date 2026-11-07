<script lang="ts">
	import type { Component } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Path } from '$app/types';
	import Bot from '@lucide/svelte/icons/bot';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import GitPullRequestArrow from '@lucide/svelte/icons/git-pull-request-arrow';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Settings from '@lucide/svelte/icons/settings';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import {
		isNavItemActive,
		navGroups,
		navItems,
		type NavGroup,
		type NavKey
	} from '#lib/navigation.js';
	import { m } from '#lib/paraglide/messages.js';
	import {
		deLocalizeHref,
		getLocale,
		locales,
		localizeHref,
		setLocale
	} from '#lib/paraglide/runtime.js';

	const labels: Record<NavKey, () => string> = {
		dashboard: m.nav_dashboard,
		repositories: m.nav_repositories,
		agent: m.nav_agent,
		runs: m.nav_runs,
		settings: m.nav_settings
	};

	const icons: Record<NavKey, Component> = {
		dashboard: LayoutDashboard,
		repositories: FolderGit2,
		agent: Bot,
		runs: ListChecks,
		settings: Settings
	};

	const groupLabels: Record<NavGroup, () => string> = {
		workspace: m.nav_section_workspace,
		workflows: m.nav_section_workflows
	};

	const currentPath = $derived(deLocalizeHref(page.url.pathname));
	const href = (path: string) => resolve(localizeHref(path) as Path);
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg">
					{#snippet child({ props })}
						<a href={href('/')} {...props}>
							<div
								class="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"
							>
								<GitPullRequestArrow class="size-4" />
							</div>
							<div class="grid flex-1 text-left leading-tight">
								<span class="truncate font-semibold">{m.app_name()}</span>
								<span class="truncate text-xs text-muted-foreground">{m.app_tagline()}</span>
							</div>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		{#each navGroups as group (group)}
			<Sidebar.Group>
				<Sidebar.GroupLabel>{groupLabels[group]()}</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each navItems.filter((i) => i.group === group) as item (item.key)}
							{@const Icon = icons[item.key]}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									isActive={isNavItemActive(item.path, currentPath)}
									tooltipContent={labels[item.key]()}
								>
									{#snippet child({ props })}
										<a
											href={href(item.path)}
											aria-current={isNavItemActive(item.path, currentPath) ? 'page' : undefined}
											{...props}
										>
											<Icon />
											<span>{labels[item.key]()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/each}
	</Sidebar.Content>

	<Sidebar.Footer>
		<div class="flex items-center justify-between gap-2 px-2 group-data-[collapsible=icon]:hidden">
			<ThemeToggle />
			<div class="flex items-center gap-1" role="group" aria-label={m.language_label()}>
				{#each locales as locale (locale)}
					<button
						type="button"
						class="rounded-md px-2 py-1 text-xs font-medium uppercase hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent"
						aria-pressed={getLocale() === locale}
						onclick={() => setLocale(locale)}
					>
						{locale}
					</button>
				{/each}
			</div>
		</div>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
