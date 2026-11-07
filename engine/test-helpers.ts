import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Temporary folders that are removed by `cleanup()`. */
export function tempDirs() {
	const dirs: string[] = [];
	return {
		make(prefix = 'patchwork-test-') {
			const dir = mkdtempSync(path.join(tmpdir(), prefix));
			dirs.push(dir);
			return dir;
		},
		cleanup() {
			for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		}
	};
}

export function run(cwd: string, ...args: string[]) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Create a git repository with one commit and, optionally, an `origin` remote. */
export function createRepo(dir: string, opts: { remote?: string; branch?: string } = {}) {
	run(dir, 'init', '-q', '-b', opts.branch ?? 'main');
	run(dir, 'config', 'user.email', 'test@example.com');
	run(dir, 'config', 'user.name', 'Test');
	writeFileSync(path.join(dir, 'README.md'), '# test\n');
	run(dir, 'add', '.');
	run(dir, 'commit', '-q', '-m', 'init');
	if (opts.remote) run(dir, 'remote', 'add', 'origin', opts.remote);
	return dir;
}

/**
 * A repository whose remote looks like GitHub (`https://github.com/<slug>.git`) but whose pushes
 * and fetches go to a local bare repository, so nothing leaves the machine.
 */
export function createGitHubLikeRepo(dir: string, bareDir: string, slug: string) {
	run(bareDir, 'init', '-q', '--bare', '-b', 'main');
	const remote = `https://github.com/${slug}.git`;
	createRepo(dir, { remote });
	run(dir, 'config', `url.${bareDir}.insteadOf`, remote);
	run(dir, 'push', '-q', 'origin', 'main');
	return { dir, bareDir, remote };
}

/** Like createGitHubLikeRepo, for any host (e.g. a GitLab remote rewritten to a bare repo). */
export function createHostedLikeRepo(dir: string, bareDir: string, remote: string) {
	run(bareDir, 'init', '-q', '--bare', '-b', 'main');
	createRepo(dir, { remote });
	run(dir, 'config', `url.${bareDir}.insteadOf`, remote);
	run(dir, 'push', '-q', 'origin', 'main');
	return { dir, bareDir, remote };
}
