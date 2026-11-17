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

/** Words a request is phrased with that say nothing about the change itself. */
const FILLER = new Set(
	(
		'a an the can could would will you your please pls i im we us our me my want wanted need ' +
		'needs like let lets make sure just also so that this these those it its is are be was ' +
		'were when while still to of in on at for from with and or but by as into some any there ' +
		'here hey hi thanks thank should'
	).split(' ')
);

/**
 * A short branch name from an instruction: its first few meaningful words, e.g. "Can you upgrade
 * eslint to v10 please" becomes `upgrade-eslint-v10`.
 */
export function suggestBranchName(instruction: string): string {
	const words = instruction
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/'/g, '')
		.split(/[^a-z0-9]+/)
		.filter((word) => word && !FILLER.has(word));
	let name = '';
	for (const word of words.slice(0, 5)) {
		const next = name ? `${name}-${word}` : word;
		if (next.length > 40) break;
		name = next;
	}
	return name || words[0]?.slice(0, 40) || 'change';
}

/**
 * The name, or with `-2`, `-3`… added when a branch already has it: here, on the remote as far as
 * the last fetch knows, or in `reserved` (tasks whose branch isn't made yet).
 */
export async function uniqueBranchName(
	repo: Repository,
	name: string,
	reserved: Iterable<string> = []
): Promise<string> {
	const held = new Set(reserved);
	const cloned = !!(await stat(repo.path).catch(() => null));
	const exists = async (ref: string) =>
		!!(await tryGit(repo.path, ['rev-parse', '--verify', '--quiet', ref]));
	const taken = async (branch: string) => {
		if (held.has(branch)) return true;
		if (!cloned) return false;
		return (
			(await exists(`refs/heads/${branch}`)) ||
			(await exists(`refs/remotes/${repo.remoteName}/${branch}`))
		);
	};
	let branch = name;
	for (let n = 2; await taken(branch); n++) branch = `${name}-${n}`;
	return branch;
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

/**
 * Create an isolated worktree at the latest commit of a pull request's branch, to add to it.
 * It's detached: no local branch is made or moved (yours may have the same name), and
 * publishing pushes HEAD to the branch on the remote. Returns the commit it starts from.
 */
export async function createPullRequestWorktree(opts: {
	repo: Repository;
	/** The pull request's branch on the remote. */
	branch: string;
	worktreePath: string;
	log: (text: string) => void;
	authEnv?: Record<string, string>;
}): Promise<string> {
	const { repo, branch, worktreePath, log } = opts;
	const tracking = `refs/remotes/${repo.remoteName}/${branch}`;
	log(`Fetching ${repo.remoteName}/${branch}…`);
	try {
		await git(
			repo.path,
			['fetch', '--quiet', repo.remoteName, `+refs/heads/${branch}:${tracking}`],
			{
				timeoutMs: 60_000,
				env: opts.authEnv
			}
		);
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new EngineError(
			'git_failed',
			`Could not fetch the pull request’s branch ${branch}: ${stderr || 'git fetch failed'}`
		);
	}
	const head = await git(repo.path, ['rev-parse', '--verify', `${tracking}^{commit}`]);
	try {
		await git(repo.path, ['worktree', 'add', '--quiet', '--detach', worktreePath, head]);
	} catch (error) {
		throw new EngineError(
			'git_failed',
			`Could not create the worktree: ${(error as Error).message}`
		);
	}
	log(`Checked out ${branch} at ${head.slice(0, 8)} in ${worktreePath}`);
	return head;
}

/**
 * A worktree for squashing a pull request's commits: at the commit its branch started from (its
 * merge base with the base branch), with the changes of all its commits staged, so committing
 * makes one commit of them. Returns that commit (`baseCommit`) and the branch's latest commit
 * (`head`), which the squashed one replaces.
 */
export async function createSquashWorktree(opts: {
	repo: Repository;
	branch: string;
	/** The branch the pull request goes into. */
	baseBranch: string;
	worktreePath: string;
	log: (text: string) => void;
	authEnv?: Record<string, string>;
}): Promise<{ baseCommit: string; head: string }> {
	const { repo, baseBranch, worktreePath, log } = opts;
	const head = await createPullRequestWorktree(opts);
	const tracking = `refs/remotes/${repo.remoteName}/${baseBranch}`;
	const fetched = await tryGit(
		repo.path,
		['fetch', '--quiet', repo.remoteName, `+refs/heads/${baseBranch}:${tracking}`],
		{ timeoutMs: 60_000, env: opts.authEnv }
	);
	if (fetched === null)
		log(`Could not fetch ${repo.remoteName}/${baseBranch}; using the last fetched copy.`);
	const mergeBase = await tryGit(repo.path, ['merge-base', tracking, head]);
	if (!mergeBase) {
		throw new EngineError(
			'git_failed',
			`Could not find where ${opts.branch} started from ${baseBranch}.`
		);
	}
	const count = Number(await git(repo.path, ['rev-list', '--count', `${mergeBase}..${head}`]));
	if (count === 0) {
		throw new EngineError('nothing_to_publish', `${opts.branch} has no commits to squash.`);
	}
	await git(worktreePath, ['reset', '--quiet', '--soft', mergeBase]);
	log(
		`Squashed ${count} ${count === 1 ? 'commit' : 'commits'} of ${opts.branch} onto ${mergeBase.slice(0, 8)}, where it started from ${baseBranch}.`
	);
	return { baseCommit: mergeBase, head };
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
