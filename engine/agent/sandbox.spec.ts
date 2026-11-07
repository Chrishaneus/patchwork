import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../test-helpers';
import { noSandboxNote } from './runner';
import {
	credentialFiles,
	PACKAGE_REGISTRIES,
	sandboxSettings,
	sandboxSupport,
	windowsCredentialFiles
} from './sandbox';

const dirs = tempDirs();
const PATH = process.env.PATH;
afterEach(() => {
	process.env.PATH = PATH;
	dirs.cleanup();
});

/** A folder holding fake executables with these names, exiting with `status`. */
function binDir(names: string[], status = 0) {
	const dir = dirs.make('patchwork-bin-');
	for (const name of names) {
		writeFileSync(path.join(dir, name), `#!/bin/sh\nexit ${status}\n`);
		chmodSync(path.join(dir, name), 0o755);
	}
	return dir;
}

describe('sandboxSupport', () => {
	it('is there on macOS, and not on Windows', () => {
		expect(sandboxSupport('darwin')).toEqual({ available: true, missing: [], blocked: false });
		expect(sandboxSupport('win32')).toEqual({ available: false, missing: [], blocked: false });
		expect(noSandboxNote(sandboxSupport('win32'))).toMatch(/isn’t available on this system/);
	});

	it('needs bubblewrap and socat on Linux', () => {
		process.env.PATH = binDir(['bwrap']);
		expect(sandboxSupport('linux')).toEqual({
			available: false,
			missing: ['socat'],
			blocked: false
		});
		expect(noSandboxNote(sandboxSupport('linux'))).toBe(
			'Shell commands run without a sandbox: install socat to turn it on.'
		);
		process.env.PATH = binDir(['bwrap', 'socat']);
		expect(sandboxSupport('linux')).toEqual({ available: true, missing: [], blocked: false });
	});

	it('notices when bubblewrap may not create namespaces', () => {
		process.env.PATH = [binDir(['bwrap'], 1), binDir(['socat'])].join(path.delimiter);
		expect(sandboxSupport('linux')).toEqual({ available: false, missing: [], blocked: true });
		expect(noSandboxNote(sandboxSupport('linux'))).toMatch(/compose\.yaml/);
	});
});

describe('credentialFiles', () => {
	it('finds the stores where Linux tools keep them, following XDG_CONFIG_HOME', () => {
		expect(credentialFiles('linux', {}, '/home/me')).toEqual([
			'/home/me/.ssh',
			'/home/me/.git-credentials',
			'/home/me/.config/git/credentials',
			'/home/me/.netrc',
			'/home/me/.config/gh',
			'/home/me/.config/glab-cli',
			'/home/me/.claude/.credentials.json'
		]);
		const moved = credentialFiles('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/me');
		expect(moved).toEqual(
			expect.arrayContaining([
				'/cfg/git/credentials',
				'/cfg/gh',
				'/cfg/glab-cli',
				'/home/me/.config/glab-cli'
			])
		);
	});

	it('uses Application Support for glab on macOS, and ~/.config for gh', () => {
		const files = credentialFiles('darwin', {}, '/Users/me');
		expect(files).toEqual(
			expect.arrayContaining([
				'/Users/me/.config/gh',
				'/Users/me/Library/Application Support/glab-cli',
				'/Users/me/.config/glab-cli'
			])
		);
	});

	it('uses %APPDATA% and Windows paths on Windows', () => {
		const files = credentialFiles(
			'win32',
			{ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
			'C:\\Users\\me'
		);
		expect(files).toEqual(
			expect.arrayContaining([
				'C:\\Users\\me\\.ssh',
				'C:\\Users\\me\\_netrc',
				'C:\\Users\\me\\AppData\\Roaming\\GitHub CLI',
				'C:\\Users\\me\\AppData\\Roaming\\glab-cli',
				'C:\\Users\\me\\.claude\\.credentials.json'
			])
		);
	});

	it('follows the tools’ own config folder variables', () => {
		const files = credentialFiles(
			'linux',
			{ GH_CONFIG_DIR: '/gh', GLAB_CONFIG_DIR: '/glab', CLAUDE_CONFIG_DIR: '/claude' },
			'/home/me'
		);
		expect(files).toEqual(expect.arrayContaining(['/gh', '/glab', '/claude/.credentials.json']));
		expect(files).not.toContain('/home/me/.config/gh');
	});
});

describe('windowsCredentialFiles', () => {
	it('protects the Windows profiles mounted under WSL, as POSIX paths', () => {
		const users = dirs.make('patchwork-users-');
		for (const name of ['Christian', 'Public', 'Default']) mkdirSync(path.join(users, name));
		const files = windowsCredentialFiles({ wsl: true, usersDir: users });
		expect(files).toEqual(
			expect.arrayContaining([
				`${users}/Christian/.ssh`,
				`${users}/Christian/.git-credentials`,
				`${users}/Christian/AppData/Roaming/GitHub CLI`,
				`${users}/Christian/.claude/.credentials.json`
			])
		);
		expect(files.some((f) => f.includes('/Public/') || f.includes('/Default/'))).toBe(false);
		expect(files.every((f) => !f.includes('\\'))).toBe(true);
	});

	it('is empty outside WSL', () => {
		const users = dirs.make('patchwork-users-');
		mkdirSync(path.join(users, 'Christian'));
		expect(windowsCredentialFiles({ wsl: false, usersDir: users })).toEqual([]);
	});
});

describe('sandboxSettings', () => {
	it('keeps commands in the working copy, off GitHub and away from credentials', () => {
		const cwd = dirs.make('patchwork-wt-');
		const gitDir = path.join(dirs.make('patchwork-repo-'), '.git', 'worktrees', 'task');
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(path.join(cwd, '.git'), `gitdir: ${gitDir}\n`);

		const settings = sandboxSettings({ cwd, protectedFiles: ['/data/secrets.json'] });
		expect(settings).toMatchObject({
			enabled: true,
			autoAllowBashIfSandboxed: false,
			allowUnsandboxedCommands: false,
			network: { strictAllowlist: true },
			filesystem: { allowWrite: [gitDir] }
		});
		expect(settings.network?.allowedDomains).toContain('registry.npmjs.org');
		for (const host of ['github.com', 'api.github.com', 'gitlab.com']) {
			expect(PACKAGE_REGISTRIES).not.toContain(host);
		}
		const envVars = settings.credentials?.envVars?.map((v) => [v.name, v.mode]);
		expect(envVars).toEqual(
			expect.arrayContaining([
				['ANTHROPIC_API_KEY', 'deny'],
				['GITHUB_TOKEN', 'deny'],
				['GITLAB_TOKEN', 'deny']
			])
		);
		const files = settings.credentials?.files?.map((f) => f.path);
		expect(files).toEqual(
			expect.arrayContaining([path.join(homedir(), '.ssh'), '/data/secrets.json'])
		);
	});

	it('allows no extra writes outside a worktree', () => {
		const settings = sandboxSettings({ cwd: dirs.make(), protectedFiles: [] });
		expect(settings.filesystem?.allowWrite).toEqual([]);
	});
});
