import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
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

/**
 * Credential stores the agent's commands must not read: SSH keys, git's stored passwords, and the
 * GitHub CLI (gh), GitLab CLI (glab), Claude Code and Codex logins. Each is where that tool looks for it on this platform,
 * including when an environment variable has moved it. Stores in the system keychain (macOS
 * Keychain, Windows Credential Manager) aren't files and aren't listed.
 */
export function credentialFiles(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	/** How to join paths; WSL reads a Windows profile through POSIX paths under /mnt. */
	p: path.PlatformPath = platform === 'win32' ? path.win32 : path.posix
): string[] {
	const windows = platform === 'win32';
	const xdgConfig = env.XDG_CONFIG_HOME || null;
	const dotConfig = p.join(home, '.config');
	const config = xdgConfig ?? dotConfig;
	const appData = windows
		? (env.APPDATA ?? p.join(home, 'AppData', 'Roaming'))
		: platform === 'darwin'
			? p.join(home, 'Library', 'Application Support')
			: config;

	const githubCliDir = () => {
		if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
		if (xdgConfig) return p.join(xdgConfig, 'gh');
		return windows ? p.join(appData, 'GitHub CLI') : p.join(dotConfig, 'gh');
	};
	// Older GitLab CLI versions used ~/.config on every platform.
	const gitlabCliDirs = env.GLAB_CONFIG_DIR
		? [env.GLAB_CONFIG_DIR]
		: [p.join(appData, 'glab-cli'), p.join(dotConfig, 'glab-cli')];
	const claudeDir = env.CLAUDE_CONFIG_DIR || p.join(home, '.claude');
	const codexDir = env.CODEX_HOME || p.join(home, '.codex');

	const files = [
		p.join(home, '.ssh'),
		p.join(home, '.git-credentials'),
		p.join(config, 'git', 'credentials'),
		p.join(home, '.netrc'),
		...(windows ? [p.join(home, '_netrc')] : []),
		githubCliDir(),
		...gitlabCliDirs,
		p.join(claudeDir, '.credentials.json'),
		p.join(codexDir, 'auth.json')
	];
	return [...new Set(files)];
}

const WINDOWS_SHARED_PROFILES = ['all users', 'default', 'default user', 'public'];

function isWsl() {
	if (process.env.WSL_DISTRO_NAME) return true;
	try {
		return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
	} catch {
		return false;
	}
}

/**
 * Under WSL the Windows drives are mounted (/mnt/c), so the Windows profiles' credential stores
 * are readable from Linux too. Their files, as POSIX paths; none outside WSL.
 */
export function windowsCredentialFiles(opts: { wsl?: boolean; usersDir?: string } = {}): string[] {
	const { wsl = isWsl(), usersDir = '/mnt/c/Users' } = opts;
	if (!wsl) return [];
	let profiles: string[];
	try {
		profiles = readdirSync(usersDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !WINDOWS_SHARED_PROFILES.includes(d.name.toLowerCase()))
			.map((d) => path.posix.join(usersDir, d.name));
	} catch {
		return [];
	}
	return profiles.flatMap((home) => {
		const appData = path.posix.join(home, 'AppData', 'Roaming');
		return credentialFiles('win32', { APPDATA: appData }, home, path.posix);
	});
}

export type SandboxSupport = {
	available: boolean;
	/** Linux tools to install. */
	missing: string[];
	/** bubblewrap is there but may not create namespaces (Docker's default seccomp profile). */
	blocked: boolean;
	/** A one-time setup with administrator approval would turn it on (Codex on Windows). */
	setup: boolean;
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
	const none = { available: false, missing: [], blocked: false, setup: false };
	if (platform === 'darwin') return { ...none, available: true };
	if (platform !== 'linux') return none;
	const missing = [
		['bwrap', 'bubblewrap'],
		['socat', 'socat']
	]
		.filter(([command]) => !onPath(command))
		.map(([, pkg]) => pkg);
	if (missing.length > 0) return { ...none, missing };
	const blocked = !bubblewrapWorks();
	return { ...none, available: !blocked, blocked };
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
 * What the agent's shell commands may do, whichever agent runs them: each runner turns it into
 * its own sandbox's settings.
 */
export type SandboxPolicy = {
	/** The only folders commands may write to: the working copy and its git folder, or none. */
	writable: string[];
	/** The only hosts commands may connect to. */
	allowedDomains: string[];
	/** Files and folders commands may not read. */
	deniedFiles: string[];
	/** Environment variables commands may not see. */
	deniedEnv: string[];
};

/**
 * The agent's shell commands write only in the working copy, connect only to package registries,
 * and see no tokens, keys or credential files, the key the agent itself signs in with included.
 * Read-only workflows (review, explore, ask) may write nowhere.
 */
export function sandboxPolicy(opts: {
	cwd: string;
	protectedFiles: string[];
	readOnly?: boolean;
}): SandboxPolicy {
	const gitDir = worktreeGitDir(opts.cwd);
	return {
		writable: opts.readOnly ? [] : gitDir ? [opts.cwd, gitDir] : [opts.cwd],
		allowedDomains: PACKAGE_REGISTRIES,
		deniedFiles: [
			...credentialFiles(),
			...(process.platform === 'linux' ? windowsCredentialFiles() : []),
			...opts.protectedFiles
		],
		deniedEnv: SECRET_ENV
	};
}
