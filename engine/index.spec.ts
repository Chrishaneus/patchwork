import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineApi, RepositoryWithStatus } from '#lib/engine/contract.js';
import { createEngine, handleEngineCall } from './index';
import { createRepo, run, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

function setup() {
	return createEngine({ dataDir: dirs.make('patchwork-data-') });
}

async function call<T>(engine: EngineApi, method: string, input?: unknown) {
	return (await handleEngineCall(engine, method, input)) as
		{ ok: true; value: T } | { ok: false; error: { code: string } };
}

describe('engine repositories', () => {
	it('adds a git repository with a GitHub remote', async () => {
		const engine = setup();
		const repoDir = createRepo(dirs.make(), { remote: 'git@github.com:acme/widgets.git' });

		const repo = await engine.addRepository({ path: repoDir });

		expect(repo).toMatchObject({
			name: 'widgets',
			slug: 'acme/widgets',
			provider: 'github',
			remoteName: 'origin',
			defaultBranch: 'main',
			status: { available: true, currentBranch: 'main', uncommittedChanges: 0 }
		});
		expect(await engine.listRepositories({})).toHaveLength(1);
	});

	it('stores the repository root when a sub-folder is chosen', async () => {
		const engine = setup();
		const repoDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/widgets.git' });
		const sub = path.join(repoDir, 'src');
		mkdirSync(sub);

		const repo = await engine.addRepository({ path: sub });

		expect(repo.path).toBe(run(repoDir, 'rev-parse', '--show-toplevel'));
	});

	it('uses the remote HEAD as the default branch', async () => {
		const engine = setup();
		const upstream = createRepo(dirs.make(), { branch: 'develop' });
		const clone = dirs.make();
		run(clone, 'clone', '-q', upstream, '.');

		const repo = await engine.addRepository({ path: clone });

		expect(repo.defaultBranch).toBe('develop');
		expect(repo.slug).toBeNull();
		expect(repo.provider).toBe('other');
	});

	it('rejects folders that are missing, not git, have no remote, or are already added', async () => {
		const engine = setup();
		const plain = dirs.make();
		const noRemote = createRepo(dirs.make());
		const ok = createRepo(dirs.make(), { remote: 'https://github.com/acme/a.git' });
		await engine.addRepository({ path: ok });

		const codes = await Promise.all(
			[path.join(plain, 'missing'), plain, noRemote, ok].map(async (p) => {
				const result = await call(engine, 'addRepository', { path: p });
				return result.ok ? 'ok' : result.error.code;
			})
		);

		expect(codes).toEqual(['path_not_found', 'not_a_git_repository', 'no_remote', 'already_added']);
	});

	it('reports uncommitted changes and missing folders when checking', async () => {
		const engine = setup();
		const repoDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/a.git' });
		const { id } = await engine.addRepository({ path: repoDir });
		writeFileSync(path.join(repoDir, 'new.txt'), 'x');

		const checked: RepositoryWithStatus = await engine.checkRepository({ id });
		expect(checked.status.uncommittedChanges).toBe(1);

		dirs.cleanup();
		const missing = await engine.checkRepository({ id });
		expect(missing.status.available).toBe(false);
	});

	it('removes a repository and persists the list across engine instances', async () => {
		const dataDir = dirs.make('patchwork-data-');
		const a = createRepo(dirs.make(), { remote: 'https://github.com/acme/a.git' });
		const b = createRepo(dirs.make(), { remote: 'https://github.com/acme/b.git' });
		const first = createEngine({ dataDir });
		const added = await first.addRepository({ path: a });
		await first.addRepository({ path: b });
		await first.removeRepository({ id: added.id });

		const second = createEngine({ dataDir });
		expect((await second.listRepositories({})).map((r) => r.name)).toEqual(['b']);
	});

	it('returns stable error codes for unknown methods, bad input and unknown ids', async () => {
		const engine = setup();
		expect(await call(engine, 'deleteEverything')).toMatchObject({
			error: { code: 'unknown_method' }
		});
		expect(await call(engine, 'addRepository', 'oops')).toMatchObject({
			error: { code: 'invalid_input' }
		});
		expect(await call(engine, 'removeRepository', { id: 'nope' })).toMatchObject({
			error: { code: 'repository_not_found' }
		});
	});
});

describe('repository roots (server mode)', () => {
	it('only accepts repositories inside the roots and lists the ones found there', async () => {
		const root = dirs.make('patchwork-root-');
		const inside = path.join(root, 'widgets');
		const nested = path.join(root, 'team', 'api');
		mkdirSync(inside);
		mkdirSync(nested, { recursive: true });
		createRepo(inside, { remote: 'https://github.com/acme/widgets.git' });
		createRepo(nested, { remote: 'https://github.com/acme/api.git' });
		mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
		const outside = createRepo(dirs.make(), { remote: 'https://github.com/acme/other.git' });

		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), repositoryRoots: [root] });

		expect((await engine.listRepositoryCandidates({})).candidates.map((c) => c.name)).toEqual([
			'api',
			'widgets'
		]);
		await expect(engine.addRepository({ path: outside })).rejects.toMatchObject({
			code: 'outside_repository_roots'
		});
		await engine.addRepository({ path: inside });
		expect((await engine.listRepositoryCandidates({})).candidates.map((c) => c.name)).toEqual([
			'api'
		]);
	});

	it('has no candidates on desktop', async () => {
		expect(await setup().listRepositoryCandidates({})).toEqual({ roots: [], candidates: [] });
	});
});
