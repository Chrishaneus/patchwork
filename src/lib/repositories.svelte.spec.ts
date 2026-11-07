import { describe, expect, it } from 'vitest';
import { createEngineClient } from '#lib/engine/client.js';
import type { EngineResult, RepositoryWithStatus } from '#lib/engine/contract.js';
import { RepositoriesState } from './repositories.svelte';

const repo = (name: string): RepositoryWithStatus => ({
	id: name,
	name,
	path: `/repos/${name}`,
	remoteName: 'origin',
	remoteUrl: `git@github.com:acme/${name}.git`,
	provider: 'github',
	slug: `acme/${name}`,
	defaultBranch: 'main',
	addedAt: '2026-11-06T00:00:00.000Z',
	checkCommand: null,
	managed: false,
	cloneStatus: null,
	cloneError: null,
	status: { available: true, currentBranch: 'main', uncommittedChanges: 0, checkedAt: '' }
});

/** In-memory engine for UI tests. */
function fakeEngine(initial: RepositoryWithStatus[]) {
	let items = [...initial];
	return createEngineClient(async (method, input): Promise<EngineResult<unknown>> => {
		const { path, id } = (input ?? {}) as { path?: string; id?: string };
		switch (method) {
			case 'listRepositories':
				return { ok: true, value: items };
			case 'addRepository': {
				if (path === '/plain')
					return { ok: false, error: { code: 'not_a_git_repository', message: '' } };
				const added = repo(path!.split('/').pop()!);
				items.push(added);
				return { ok: true, value: added };
			}
			case 'removeRepository':
				items = items.filter((r) => r.id !== id);
				return { ok: true, value: { id } };
			default:
				return { ok: true, value: items.find((r) => r.id === id) };
		}
	});
}

describe('RepositoriesState', () => {
	it('loads, adds in name order, and removes repositories', async () => {
		const state = new RepositoriesState(fakeEngine([repo('zeta')]));
		await state.load();
		expect(state.loaded).toBe(true);

		expect(await state.add('/repos/alpha')).toBeNull();
		expect(state.items.map((r) => r.name)).toEqual(['alpha', 'zeta']);

		await state.remove('zeta');
		expect(state.items.map((r) => r.name)).toEqual(['alpha']);
	});

	it('returns the error code when a folder cannot be added', async () => {
		const state = new RepositoriesState(fakeEngine([]));
		expect(await state.add('/plain')).toBe('not_a_git_repository');
		expect(state.items).toEqual([]);
	});
});
