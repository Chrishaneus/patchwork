import { chmod, lstat, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
	EngineError,
	type DiffStat,
	type Repository,
	type TaskDiff
} from '#lib/engine/contract.js';
import { git, tryGit } from './git.js';

const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** Turn an instruction into a readable branch name, e.g. `ai/upgrade-eslint-to-v10-3f9a1c`. */
export function suggestBranchName(instruction: string, uniqueSuffix: string): string {
	const slug = instruction
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/, '');
	return `ai/${slug || 'change'}-${uniqueSuffix}`;
}

/**
 * Check a new branch name: valid for git and, when the repository exists locally, not taken yet.
 * Repositories that aren't cloned yet only get the format check.
 */
export async function assertValidBranchName(repoPath: string, branch: string) {
	const exists = !!(await stat(repoPath).catch(() => null));
	const valid = await tryGit(exists ? repoPath : tmpdir(), [
		'check-ref-format',
		'--branch',
		branch
	]);
	if (!valid) throw new EngineError('invalid_branch', `Not a valid branch name: ${branch}`);
	if (
		exists &&
		(await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
	) {
		throw new EngineError('invalid_branch', `Branch already exists: ${branch}`);
	}
}

/**
 * Create an isolated worktree on a new branch from the latest base branch. Your own checkout and
 * its uncommitted changes are never touched. Returns the commit the branch starts from.
 */
export async function createWorktree(opts: {
	repo: Repository;
	branch: string;
	worktreePath: string;
	log: (text: string) => void;
	/** git credentials for HTTPS remotes (private clones). */
	authEnv?: Record<string, string>;
}): Promise<string> {
	const { repo, branch, worktreePath, log } = opts;
	const base = repo.defaultBranch;

	log(`Fetching ${repo.remoteName}/${base}…`);
	const fetched = await tryGit(repo.path, ['fetch', '--quiet', repo.remoteName, base], {
		timeoutMs: 60_000,
		env: opts.authEnv
	});
	if (fetched === null) log(`Could not fetch ${repo.remoteName}; using the local copy of ${base}.`);

	const candidates = [`refs/remotes/${repo.remoteName}/${base}`, `refs/heads/${base}`, 'HEAD'];
	let baseCommit: string | null = null;
	for (const ref of candidates) {
		baseCommit = await tryGit(repo.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
		if (baseCommit) break;
	}
	if (!baseCommit)
		throw new EngineError('git_failed', `Could not find a commit to start from in ${repo.path}`);

	try {
		await git(repo.path, ['worktree', 'add', '--quiet', '-b', branch, worktreePath, baseCommit]);
	} catch (error) {
		throw new EngineError(
			'git_failed',
			`Could not create the worktree: ${(error as Error).message}`
		);
	}
	log(`Created branch ${branch} from ${baseCommit.slice(0, 8)} in ${worktreePath}`);
	return baseCommit;
}

/** Everything changed in the worktree since `baseCommit`, including new and committed files. */
export async function collectDiff(worktreePath: string, baseCommit: string): Promise<TaskDiff> {
	// Mark new files as "intent to add" so they show up in the diff without staging content.
	await git(worktreePath, ['add', '--all', '--intent-to-add']);
	const numstat = await git(worktreePath, ['diff', '--numstat', baseCommit]);
	const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
	for (const line of numstat.split('\n').filter(Boolean)) {
		const [added, removed] = line.split('\t');
		stat.files += 1;
		stat.insertions += Number(added) || 0;
		stat.deletions += Number(removed) || 0;
	}

	const patch = await git(
		worktreePath,
		['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', baseCommit],
		{
			trim: false
		}
	);
	const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
	return { stat, patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch, truncated };
}

/** The diff between two commits in the repository (used once a published task's worktree is gone). */
export async function diffBetween(repoPath: string, base: string, head: string): Promise<TaskDiff> {
	const numstat = await git(repoPath, ['diff', '--numstat', base, head]);
	const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
	for (const line of numstat.split('\n').filter(Boolean)) {
		const [added, removed] = line.split('\t');
		stat.files += 1;
		stat.insertions += Number(added) || 0;
		stat.deletions += Number(removed) || 0;
	}
	const patch = await git(
		repoPath,
		['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', base, head],
		{
			trim: false
		}
	);
	const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
	return { stat, patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch, truncated };
}

/**
 * Make every file and folder in a working copy read-only, or writable again. For read-only
 * workflows when commands can't be sandboxed: it stops `sed -i`, `rm` or `> file`, though a
 * command could still change the permissions back. Symlinks are skipped, since chmod follows them.
 */
export async function setWritable(dir: string, writable: boolean): Promise<void> {
	const info = await lstat(dir);
	if (info.isSymbolicLink()) return;
	const mode = writable ? info.mode | 0o200 : info.mode & ~0o222;
	if (writable) await chmod(dir, mode & 0o7777);
	if (info.isDirectory()) {
		for (const entry of await readdir(dir)) await setWritable(path.join(dir, entry), writable);
	}
	if (!writable) await chmod(dir, mode & 0o7777);
}

/** Whether `setWritable(dir, false)` was used on this working copy. */
async function isReadOnly(dir: string) {
	const info = await stat(dir).catch(() => null);
	return !!info && (info.mode & 0o200) === 0;
}

/** Remove a worktree but keep its branch (after publishing, or a read-only workflow's copy). */
export async function removeWorktreeOnly(repo: Repository, worktreePath: string) {
	if (await isReadOnly(worktreePath)) await setWritable(worktreePath, true).catch(() => {});
	await tryGit(repo.path, ['worktree', 'remove', '--force', worktreePath]);
	await rm(worktreePath, { recursive: true, force: true });
	await tryGit(repo.path, ['worktree', 'prune']);
}

/** Remove the worktree and delete its branch. Safe to call when either is already gone. */
export async function removeWorktree(repo: Repository, worktreePath: string, branch: string) {
	await tryGit(repo.path, ['worktree', 'remove', '--force', worktreePath]);
	await rm(worktreePath, { recursive: true, force: true });
	await tryGit(repo.path, ['worktree', 'prune']);
	await tryGit(repo.path, ['branch', '-D', branch]);
}
