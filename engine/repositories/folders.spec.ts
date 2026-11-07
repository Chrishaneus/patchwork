import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from '../index';
import { createRepo, tempDirs } from '../test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

// createRepo expects the folder to exist.
const mk = (p: string) => {
	mkdirSync(p, { recursive: true });
	return p;
};

describe('folder browser', () => {
	it('lists folders one level at a time, marks repositories, and skips hidden and dependency folders', async () => {
		const root = dirs.make('patchwork-root-');
		createRepo(mk(path.join(root, 'app')), { remote: 'https://github.com/acme/app.git' });
		createRepo(mk(path.join(root, 'projects', 'api')), {
			remote: 'https://github.com/acme/api.git'
		});
		mk(path.join(root, '.hidden'));
		mk(path.join(root, 'node_modules'));
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			repositoryRoots: [root],
			pullRequestSyncMs: 0
		});

		const top = await engine.browseFolders({});
		expect(top.path).toBe(root);
		expect(top.parent).toBeUndefined();
		expect(top.entries).toEqual([
			{ name: 'app', path: path.join(root, 'app'), isGitRepository: true },
			{ name: 'projects', path: path.join(root, 'projects'), isGitRepository: false }
		]);

		const projects = await engine.browseFolders({ path: path.join(root, 'projects') });
		expect(projects.parent).toBe(root);
		expect(projects.entries.map((e) => [e.name, e.isGitRepository])).toEqual([['api', true]]);
	});

	it('refuses folders outside the roots, including through symlinks', async () => {
		const root = dirs.make('patchwork-root-');
		const outside = createRepo(dirs.make('patchwork-outside-'), {
			remote: 'https://github.com/acme/secret.git'
		});
		symlinkSync(outside, path.join(root, 'escape'));
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			repositoryRoots: [root],
			pullRequestSyncMs: 0
		});

		// The link isn't offered, and following it or adding through it is refused.
		expect((await engine.browseFolders({})).entries.map((e) => e.name)).not.toContain('escape');
		await expect(engine.browseFolders({ path: path.join(root, 'escape') })).rejects.toMatchObject({
			code: 'outside_repository_roots'
		});
		await expect(engine.browseFolders({ path: outside })).rejects.toMatchObject({
			code: 'outside_repository_roots'
		});
		await expect(engine.addRepository({ path: path.join(root, 'escape') })).rejects.toMatchObject({
			code: 'outside_repository_roots'
		});
		await expect(engine.browseFolders({ path: path.join(root, 'missing') })).rejects.toMatchObject({
			code: 'folder_not_found'
		});
	});

	it('works anywhere on desktop and is off on a server without local folders', async () => {
		const desktop = createEngine({ dataDir: dirs.make('patchwork-data-'), pullRequestSyncMs: 0 });
		const anywhere = dirs.make('patchwork-any-');
		mk(path.join(anywhere, 'child'));
		const listing = await desktop.browseFolders({ path: anywhere });
		expect(listing.entries.map((e) => e.name)).toEqual(['child']);
		expect(listing.parent).toBe(path.dirname(listing.path!));

		const docker = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			pullRequestSyncMs: 0,
			localPaths: false
		});
		await expect(docker.browseFolders({})).rejects.toMatchObject({ code: 'local_paths_disabled' });
	});

	it('lists several roots to choose from', async () => {
		const a = dirs.make('patchwork-a-');
		const b = dirs.make('patchwork-b-');
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			repositoryRoots: [a, b],
			pullRequestSyncMs: 0
		});
		const top = await engine.browseFolders({});
		expect(top.path).toBeNull();
		expect(top.entries.map((e) => e.path).sort()).toEqual([a, b].sort());
		expect((await engine.browseFolders({ path: a })).parent).toBeNull();
	});
});
