import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { SECRET_ENV } from '../core/env.js';

/**
 * Where the agent's shell commands may connect: package registries, so installs and builds work.
 * Everything else is refused, GitHub and GitLab included: pushing and opening pull requests is
 * the app's job, after review.
 */
export const PACKAGE_REGISTRIES = [
	'registry.npmjs.org',
	'registry.yarnpkg.com',
	'pypi.org',
	'files.pythonhosted.org',
	'crates.io',
	'index.crates.io',
	'static.crates.io',
	'proxy.golang.org',
	'sum.golang.org',
	'repo.maven.apache.org',
	'repo1.maven.org',
	'plugins.gradle.org',
	'services.gradle.org',
	'rubygems.org',
	'index.rubygems.org',
	'api.nuget.org',
	'repo.packagist.org',
	'pub.dev',
	'jsr.io',
	'deno.land'
];

/** Credential stores in the home folder the agent's commands must not read (git, SSH, CLIs). */
const CREDENTIAL_FILES = [
	'.ssh',
	'.git-credentials',
	'.config/git/credentials',
	'.netrc',
	'.config/gh',
	'.config/glab-cli',
	'.claude/.credentials.json'
];

export type SandboxSupport = {
	available: boolean;
	/** Linux tools to install. */
	missing: string[];
	/** bubblewrap is there but may not create namespaces (Docker's default seccomp profile). */
	blocked: boolean;
};

const onPath = (name: string) =>
	(process.env.PATH ?? '').split(path.delimiter).some((dir) => {
		try {
			accessSync(path.join(dir, name), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});

/** Whether bubblewrap can start an isolated process here, as the sandbox will. */
function bubblewrapWorks() {
	const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
	const flags = ['--unshare-net', '--unshare-pid'];
	return spawnSync('bwrap', [...args, ...flags, 'true'], { timeout: 5000 }).status === 0;
}

/**
 * Whether Claude Code can sandbox shell commands here: macOS always; Linux when bubblewrap and
 * socat are installed and bubblewrap may create namespaces; Windows not.
 */
export function sandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
	if (platform === 'darwin') return { available: true, missing: [], blocked: false };
	if (platform !== 'linux') return { available: false, missing: [], blocked: false };
	const missing = [
		['bwrap', 'bubblewrap'],
		['socat', 'socat']
	]
		.filter(([command]) => !onPath(command))
		.map(([, pkg]) => pkg);
	if (missing.length > 0) return { available: false, missing, blocked: false };
	const blocked = !bubblewrapWorks();
	return { available: !blocked, missing, blocked };
}

/** A worktree's own git folder (`.git` there is a file pointing at it), so git can update it. */
function worktreeGitDir(cwd: string): string | null {
	try {
		const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(cwd, '.git'), 'utf8'));
		return match ? path.resolve(cwd, match[1].trim()) : null;
	} catch {
		return null;
	}
}

/**
 * The sandbox for the agent's shell commands. They write only in the working copy (and its git
 * folder), connect only to package registries, and see no tokens, keys or credential files, the
 * Anthropic key the agent itself signs in with included. Every command runs inside it; the
 * agent can't ask to run one outside.
 */
export function sandboxSettings(opts: { cwd: string; protectedFiles: string[] }): SandboxSettings {
	const gitDir = worktreeGitDir(opts.cwd);
	return {
		enabled: true,
		// Bash still goes through the tool policy as well.
		autoAllowBashIfSandboxed: false,
		allowUnsandboxedCommands: false,
		network: { allowedDomains: PACKAGE_REGISTRIES, strictAllowlist: true },
		filesystem: { allowWrite: gitDir ? [gitDir] : [] },
		credentials: {
			envVars: SECRET_ENV.map((name) => ({ name, mode: 'deny' as const })),
			files: [
				...CREDENTIAL_FILES.map((file) => path.join(homedir(), file)),
				...opts.protectedFiles
			].map((file) => ({ path: file, mode: 'deny' as const }))
		}
	};
}
