import { EngineError, type Repository } from '#lib/engine/contract.js';
import { git, tryGit } from './git.js';

/** Make sure git can make a commit here (user.name/email from git config or GIT_AUTHOR_* env). */
async function assertIdentity(cwd: string) {
	// Empty values count as unset (compose passes unset variables as empty strings).
	const name = process.env.GIT_AUTHOR_NAME || (await tryGit(cwd, ['config', 'user.name']));
	const email = process.env.GIT_AUTHOR_EMAIL || (await tryGit(cwd, ['config', 'user.email']));
	if (!name || !email) {
		throw new EngineError(
			'git_identity_missing',
			'git has no user.name/user.email for commits. Set them with git config (or GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL on a server).'
		);
	}
}

/**
 * Commit everything in the worktree on top of whatever the agent already committed. Returns the
 * new HEAD. Refuses when the branch has no changes compared to where it started.
 */
export async function commitChanges(opts: {
	worktreePath: string;
	baseCommit: string;
	message: string;
}): Promise<string> {
	const { worktreePath, baseCommit, message } = opts;
	await git(worktreePath, ['add', '--all']);
	const staged = await git(worktreePath, ['diff', '--cached', '--name-only']);
	if (staged) {
		await assertIdentity(worktreePath);
		try {
			// The repository's own commit hooks run; if one fails, its output explains why.
			await git(worktreePath, ['commit', '--quiet', '-m', message]);
		} catch (error) {
			const output = [(error as { stdout?: string }).stdout, (error as { stderr?: string }).stderr]
				.filter(Boolean)
				.join('\n')
				.trim();
			throw new EngineError(
				'git_failed',
				`Could not commit: ${output || (error as Error).message}`
			);
		}
	}
	const head = await git(worktreePath, ['rev-parse', 'HEAD']);
	if (head === baseCommit) {
		throw new EngineError('nothing_to_publish', 'There are no changes to publish.');
	}
	return head;
}

/** Push the branch to the repository's remote and set it as upstream. */
export async function pushBranch(opts: {
	worktreePath: string;
	repo: Repository;
	branch: string;
	/** Extra git config for HTTPS credentials (see providerAuthEnv); Docker has no others. */
	authEnv?: Record<string, string>;
}) {
	try {
		await git(
			opts.worktreePath,
			['push', '--quiet', '-u', opts.repo.remoteName, `HEAD:refs/heads/${opts.branch}`],
			{ timeoutMs: 120_000, env: opts.authEnv }
		);
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		// Only git's own output: the error message would include the command line.
		throw new EngineError(
			'push_failed',
			`Could not push to ${opts.repo.remoteName}: ${stderr || 'git push failed'}`
		);
	}
}
