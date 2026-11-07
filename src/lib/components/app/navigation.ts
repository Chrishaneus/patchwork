export type NavKey = 'dashboard' | 'repositories' | 'agent' | 'runs' | 'settings';

export type NavGroup = 'workspace' | 'workflows';

export interface NavItem {
	key: NavKey;
	/** Locale-free path; localize it with `localizeHref` before linking. */
	path: string;
	group: NavGroup;
}

export const navGroups: NavGroup[] = ['workspace', 'workflows'];

export const navItems: NavItem[] = [
	{ key: 'dashboard', path: '/', group: 'workspace' },
	{ key: 'repositories', path: '/repositories', group: 'workspace' },
	{ key: 'runs', path: '/runs', group: 'workspace' },
	{ key: 'settings', path: '/settings', group: 'workspace' },
	// Changes, reviews and explorations all start from the Agent.
	{ key: 'agent', path: '/agent', group: 'workflows' }
];

/** Whether a nav item should be highlighted for the current (locale-free) pathname. */
export function isNavItemActive(itemPath: string, currentPath: string): boolean {
	const current = currentPath.length > 1 ? currentPath.replace(/\/+$/, '') : currentPath;
	if (itemPath === '/') return current === '/';
	return current === itemPath || current.startsWith(`${itemPath}/`);
}
