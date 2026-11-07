import { describe, expect, it } from 'vitest';
import { isNavItemActive } from './navigation';

describe('isNavItemActive', () => {
	it('matches the dashboard only on the root path', () => {
		expect(isNavItemActive('/', '/')).toBe(true);
		expect(isNavItemActive('/', '/repositories')).toBe(false);
	});

	it('matches a section and its sub-pages', () => {
		expect(isNavItemActive('/runs', '/runs')).toBe(true);
		expect(isNavItemActive('/runs', '/runs/123')).toBe(true);
		expect(isNavItemActive('/runs', '/runs/')).toBe(true);
	});

	it('does not match paths that only share a prefix', () => {
		expect(isNavItemActive('/runs', '/runs-archive')).toBe(false);
	});
});
