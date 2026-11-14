import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitProvider } from '#lib/engine/contract.js';

const execFileAsync = promisify(execFile);

/** Run git in `cwd` and return trimmed stdout. Throws when git exits with an error. */
export async function git(
	cwd: string,
	args: string[],
	opts: { timeoutMs?: number; trim?: boolean; env?: Record<string, string> } = {}
): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd,
		timeout: opts.timeoutMs,
		// Never prompt for credentials or open an editor from a background process.
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: '0',
			GIT_EDITOR: 'true',
			GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
			...opts.env
		},
		maxBuffer: 64 * 1024 * 1024
	});
	return opts.trim === false ? stdout : stdout.trim();
}

/** Like `git`, but returns null instead of throwing. */
export async function tryGit(
	cwd: string,
	args: string[],
	opts: { timeoutMs?: number; trim?: boolean; env?: Record<string, string> } = {}
): Promise<string | null> {
	try {
		return await git(cwd, args, opts);
	} catch {
		return null;
	}
}

export interface ParsedRemote {
	host: string;
	provider: GitProvider;
	/** `owner/repo` (or `group/subgroup/repo` on GitLab). */
	slug: string | null;
}

/** Read host, provider and slug from an HTTPS, SSH or scp-style git remote URL. */
export function parseRemoteUrl(url: string): ParsedRemote {
	let host: string;
	let pathPart: string;

	const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
	if (scpLike && !url.includes('://')) {
		host = scpLike[1];
		pathPart = scpLike[2];
	} else {
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			pathPart = parsed.pathname;
		} catch {
			return { host: '', provider: 'other', slug: null };
		}
	}

	const slug =
		pathPart
			.replace(/^\/+/, '')
			.replace(/\/+$/, '')
			.replace(/\.git$/, '') || null;
	const lowerHost = host.toLowerCase();
	const provider: GitProvider = lowerHost.includes('github')
		? 'github'
		: lowerHost.includes('gitlab')
			? 'gitlab'
			: lowerHost.includes('bitbucket')
				? 'bitbucket'
				: 'other';

	return { host, provider, slug: slug && slug.includes('/') ? slug : null };
}
