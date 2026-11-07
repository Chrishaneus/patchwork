// A safe place to try publishing: a dummy remote plus a fake GitHub, all on this machine.
//
//   npm run sandbox            set it up (if needed) and start the fake GitHub on 127.0.0.1:4010
//   npm run sandbox -- --reset start over with a fresh demo repository
//
// It creates, under .sandbox/:
//   remote.git/  a bare repository that plays the GitHub remote (pushes land here)
//   demo/        a working copy whose remote is https://github.com/sandbox/demo.git, rewritten
//                by git (url.*.insteadOf) to remote.git, so the app treats it as a GitHub repo
//   pulls.json   pull requests opened against the fake GitHub
//   gitconfig    git config for the sandboxed app: your own ~/.gitconfig plus the URL rewrite,
//                so "Sign in with GitHub" → add sandbox/demo clones from remote.git
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { startFakeGitHub } from './fake-github.ts';

const root = path.resolve(import.meta.dirname, '..', '.sandbox');
const bare = path.join(root, 'remote.git');
const demo = path.join(root, 'demo');
const slug = 'sandbox/demo';
const remoteUrl = `https://github.com/${slug}.git`;
const port = Number(process.env.SANDBOX_PORT ?? 4010);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function create() {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(bare, { recursive: true });
	git(bare, 'init', '-q', '--bare', '-b', 'main');

	mkdirSync(path.join(demo, 'src'), { recursive: true });
	git(demo, 'init', '-q', '-b', 'main');
	git(demo, 'config', 'user.name', 'Sandbox User');
	git(demo, 'config', 'user.email', 'sandbox@example.com');
	writeFileSync(
		path.join(demo, 'README.md'),
		'# Demo\n\nA tiny project for trying out Patchwork. Ask it to add a function, a test or docs.\n'
	);
	writeFileSync(
		path.join(demo, 'package.json'),
		JSON.stringify(
			{ name: 'demo', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } },
			null,
			2
		) + '\n'
	);
	writeFileSync(
		path.join(demo, 'src', 'greet.js'),
		'export function greet(name) {\n\treturn `Hello, ${name}!`;\n}\n'
	);
	writeFileSync(
		path.join(demo, 'src', 'greet.test.js'),
		"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greet.js';\n\ntest('greets by name', () => {\n\tassert.equal(greet('Ada'), 'Hello, Ada!');\n});\n"
	);
	git(demo, 'add', '.');
	git(demo, 'commit', '-q', '-m', 'Initial commit');
	git(demo, 'remote', 'add', 'origin', remoteUrl);
	git(demo, 'config', `url.${bare}.insteadOf`, remoteUrl);
	git(demo, 'push', '-q', '-u', 'origin', 'main');
}

if (process.argv.includes('--reset') || !existsSync(path.join(demo, '.git'))) {
	create();
	console.log('Created a fresh sandbox.');
}

writeFileSync(
	path.join(root, 'gitconfig'),
	`[include]\n\tpath = ${path.join(homedir(), '.gitconfig')}\n[url "${bare}"]\n\tinsteadOf = ${remoteUrl}\n`
);

const gh = await startFakeGitHub({
	port,
	repos: { [slug]: bare },
	stateFile: path.join(root, 'pulls.json'),
	user: { login: 'sandbox-user' }
});

console.log(`
Sandbox ready.
  Fake GitHub:        ${gh.url}   (pull requests, and the sign-in page)
  Demo repository:    ${remoteUrl}  (pushes go to ${bare})
  Local working copy: ${demo}

Run the desktop app against it (in another terminal), or use: npm run electron:sandbox
  GIT_CONFIG_GLOBAL=${path.join(root, 'gitconfig')} \\
  PATCHWORK_GITHUB_WEB_URL=${gh.url} PATCHWORK_GITHUB_API_URL=${gh.url} \\
  PATCHWORK_GITHUB_CLIENT_ID=Iv23liSandbox npm run electron:dev

Then: Settings → Sign in with GitHub → open the link and approve the code → Repositories →
From a URL → add sandbox/demo. Or add the local working copy from the Local folder tab.

Press Ctrl+C to stop the fake GitHub.`);
