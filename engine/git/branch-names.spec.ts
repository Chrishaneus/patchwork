import { afterEach, describe, expect, it } from 'vitest';
import type { Repository } from '#lib/engine/contract.js';
import { createRepo, run as git, tempDirs } from '../test-helpers';
import { suggestBranchName, uniqueBranchName } from './worktrees';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('suggestBranchName', () => {
	it('keeps the first few meaningful words, without the way it was asked', () => {
		expect(suggestBranchName('Can you upgrade eslint to v10 please')).toBe('upgrade-eslint-v10');
		expect(
			suggestBranchName(
				'Can you fix the sidebar when logged still showing the title when it is collapsed'
			)
		).toBe('fix-sidebar-logged-showing-title');
		expect(suggestBranchName('Add OAuth2 login')).toBe('add-oauth2-login');
		expect(suggestBranchName("Let's rename the user's profile page")).toBe(
			'rename-users-profile-page'
		);
	});

	it('stays short, and falls back to a name when nothing is left', () => {
		const long = suggestBranchName('Internationalisation localisation configuration documentation');
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long).toBe('internationalisation-localisation');
		expect(suggestBranchName('Café crème brûlée')).toBe('cafe-creme-brulee');
		expect(suggestBranchName('Please, can you?')).toBe('change');
		expect(suggestBranchName('日本語')).toBe('change');
	});
});

describe('uniqueBranchName', () => {
	it('adds a number when a branch here, on the remote or on another task has the name', async () => {
		const dir = createRepo(dirs.make());
		const repo = { path: dir, remoteName: 'origin' } as Repository;
		expect(await uniqueBranchName(repo, 'add-login')).toBe('add-login');

		git(dir, 'branch', 'add-login');
		git(dir, 'update-ref', 'refs/remotes/origin/add-login-2', 'HEAD');
		expect(await uniqueBranchName(repo, 'add-login')).toBe('add-login-3');
		expect(await uniqueBranchName(repo, 'add-login', ['add-login-3'])).toBe('add-login-4');
	});

	it('checks only the reserved names for a repository that isn’t cloned yet', async () => {
		const repo = { path: '/nowhere/at/all', remoteName: 'origin' } as Repository;
		expect(await uniqueBranchName(repo, 'x')).toBe('x');
		expect(await uniqueBranchName(repo, 'x', ['x'])).toBe('x-2');
	});
});
