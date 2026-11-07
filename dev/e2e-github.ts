// Fixtures for the browser end-to-end tests (started by playwright.config.ts):
// - .e2e/gh-*.git:  bare repositories playing https://github.com/acme/gh-demo, gh-second, gh-review
// - .e2e/gitconfig:  git config for the test server: rewrites those URLs to the bare
//                    repositories and sets a commit identity, so cloning works offline
// - a fake GitHub on the given port, which signs in as "e2e-user" and lists both
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeGitHub } from './fake-github.ts';

const root = path.resolve('.e2e');
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 4011);
const names = ['gh-demo', 'gh-second'];
mkdirSync(root, { recursive: true });

/** A bare repository with one commit, playing https://github.com/acme/<name>.git. */
function bareRepo(name: string) {
	const bare = path.join(root, `${name}.git`);
	rmSync(bare, { recursive: true, force: true });
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
	const seed = mkdtempSync(path.join(tmpdir(), `${name}-seed-`));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: seed });
	git('init', '-q', '-b', 'main');
	writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
	git('add', '.');
	git('-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '-q', '-m', 'init');
	git('push', '-q', bare, 'main');
	rmSync(seed, { recursive: true, force: true });
	return bare;
}
// gh-review is for the review and explore tests; it isn't in the signed-in user's list.
const bares = Object.fromEntries([...names, 'gh-review'].map((n) => [`acme/${n}`, bareRepo(n)]));

writeFileSync(
	path.join(root, 'gitconfig'),
	'[user]\n\tname = E2E\n\temail = e2e@example.com\n' +
		Object.entries(bares)
			.map(([slug, bare]) => `[url "${bare}"]\n\tinsteadOf = https://github.com/${slug}.git\n`)
			.join('')
);

const gh = await startFakeGitHub({
	port,
	user: { login: 'e2e-user' },
	repos: bares,
	userRepos: names.map((n) => ({
		fullName: `acme/${n}`,
		private: true,
		description: 'Repository for tests'
	}))
});
console.log(`Fake GitHub for e2e on ${gh.url}`);
