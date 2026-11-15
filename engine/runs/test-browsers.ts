import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withoutSecrets } from '../core/env.js';

/**
 * Browsers for a repository's Playwright tests. The agent's sandbox can't download them (their
 * hosts aren't allowed) or write Playwright's shared cache, so the app installs them first,
 * outside it, with the repository's own Playwright version, into a folder of its own that
 * agents can read but not change. `PLAYWRIGHT_BROWSERS_PATH` points the agent and the checks
 * there.
 */

/** A plain version (1.48.2, 1.49.0-beta-1), so a lockfile can't name another package to run. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const read = (file: string) => {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
};

/** Playwright's packages, the one that decides the browser builds first. */
const PACKAGES = ['playwright-core', '@playwright/test', 'playwright'];

/**
 * The Playwright version a repository uses, from its lockfile (npm, pnpm, Yarn or Bun), else the
 * version in package.json; null when it doesn't use Playwright for Node.
 */
export function playwrightVersion(dir: string): string | null {
	const found = (version: string | undefined | null) =>
		version && VERSION.test(version) ? version : null;
	const escape = (name: string) => name.replace(/[/.]/g, '\\$&');

	const npm = read(path.join(dir, 'package-lock.json'));
	if (npm) {
		try {
			const lock = JSON.parse(npm);
			for (const name of PACKAGES) {
				const version =
					lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
				if (found(version)) return version;
			}
		} catch {
			// An unreadable lockfile: try the others.
		}
	}
	const pnpm = read(path.join(dir, 'pnpm-lock.yaml'));
	const yarn = read(path.join(dir, 'yarn.lock'));
	const bun = read(path.join(dir, 'bun.lock'));
	for (const name of PACKAGES) {
		const version =
			// pnpm: "  playwright-core@1.48.2:" (v9) or "  /playwright-core@1.48.2:" (v6).
			(pnpm && new RegExp(`^\\s+['"]?/?${escape(name)}@(\\d[^\\s:'"(]*)`, 'm').exec(pnpm)?.[1]) ||
			// Yarn: a "playwright-core@^1.48.0:" entry, then its "version" line.
			(yarn &&
				new RegExp(`^"?${escape(name)}@[^\\n]*:\\n\\s+version:? "?([^"\\s]+)`, 'm').exec(
					yarn
				)?.[1]) ||
			// Bun: "playwright-core": ["playwright-core@1.48.2", …].
			(bun && new RegExp(`"${escape(name)}": \\["${escape(name)}@([^"]+)"`).exec(bun)?.[1]);
		if (found(version)) return version!;
	}

	const manifest = read(path.join(dir, 'package.json'));
	if (!manifest) return null;
	try {
		const pkg = JSON.parse(manifest);
		for (const name of PACKAGES) {
			const range: unknown = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
			// "^1.48.0" → 1.48.0: the oldest it allows, close enough for the browsers.
			const version = typeof range === 'string' ? /\d+\.\d+\.\d+/.exec(range)?.[0] : null;
			if (found(version)) return version!;
		}
	} catch {
		// Not JSON: nothing to go on.
	}
	return null;
}

/** The browsers a repository's Playwright config uses: Chromium, plus Firefox or WebKit if named. */
export function browsersFor(dir: string): string[] {
	const configs = ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'].map((ext) =>
		read(path.join(dir, `playwright.config.${ext}`))
	);
	const config = configs.find((text) => text !== null) ?? '';
	const browsers = ['chromium'];
	if (/firefox/i.test(config)) browsers.push('firefox');
	if (/webkit|safari/i.test(config)) browsers.push('webkit');
	return browsers;
}

export interface BrowserInstall {
	version: string;
	browsers: string[];
	browsersDir: string;
	log: (text: string) => void;
	signal: AbortSignal;
}

/** Installs the browsers: `npx playwright@<version> install <browsers>`; throws on failure. */
export type BrowserInstaller = (install: BrowserInstall) => Promise<void>;

/** The real installer, through npx; up to 10 minutes, as a first download can be slow. */
export const installWithNpx: BrowserInstaller = ({ version, browsers, browsersDir, log, signal }) =>
	new Promise((resolve, reject) => {
		const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
		const env: NodeJS.ProcessEnv = {
			...withoutSecrets({ PLAYWRIGHT_BROWSERS_PATH: browsersDir }),
			// Set for the app's own install (Docker); it would skip the download here too.
			PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: undefined
		};
		const child = spawn(npx, ['--yes', `playwright@${version}`, 'install', ...browsers], {
			cwd: browsersDir,
			env,
			shell: process.platform === 'win32',
			windowsHide: true,
			signal,
			timeout: 10 * 60_000
		});
		let output = '';
		const keep = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-4000);
			// Playwright prints a line per download; progress bars and colours are left out.
			// eslint-disable-next-line no-control-regex -- terminal colour codes start with ESC
			const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
			for (const line of text.split(/\r?\n/)) {
				if (/^(Downloading|.* downloaded to)/.test(line.trim())) log(line.trim());
			}
		};
		child.stdout.on('data', keep);
		child.stderr.on('data', keep);
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(output.trim().split('\n').slice(-3).join(' ') || `exit ${code}`));
		});
	});

/** Marks a version's browsers as installed, so later runs skip npx and the network. */
const markerFor = (browsersDir: string, version: string, browsers: string[]) =>
	path.join(browsersDir, '.installed', `${version}-${browsers.join('+')}`);

/**
 * The environment pointing at a repository's Playwright browsers, if they're installed already
 * (for the checks, which run after the agent); otherwise nothing, so Playwright looks in its
 * usual place.
 */
export function readyBrowsersEnv(dir: string, browsersDir: string): Record<string, string> {
	const version = playwrightVersion(dir);
	if (!version || !existsSync(markerFor(browsersDir, version, browsersFor(dir)))) return {};
	return { PLAYWRIGHT_BROWSERS_PATH: browsersDir };
}

/**
 * Get a repository's Playwright browsers ready, if it uses Playwright: installs what isn't yet,
 * and returns the environment that points at them. Returns nothing when there's nothing to do,
 * or when installing fails (the agent can still use browsers already on the machine).
 */
export async function prepareTestBrowsers(opts: {
	dir: string;
	browsersDir: string;
	install: BrowserInstaller;
	log: (text: string) => void;
	signal: AbortSignal;
}): Promise<Record<string, string>> {
	const version = playwrightVersion(opts.dir);
	if (!version) return {};
	const browsers = browsersFor(opts.dir);
	const env = { PLAYWRIGHT_BROWSERS_PATH: opts.browsersDir };
	const marker = markerFor(opts.browsersDir, version, browsers);
	if (existsSync(marker)) return env;

	opts.log(`Installing Playwright ${version}'s browsers for the tests (${browsers.join(', ')})…`);
	try {
		await mkdir(path.dirname(marker), { recursive: true });
		await opts.install({
			version,
			browsers,
			browsersDir: opts.browsersDir,
			log: opts.log,
			signal: opts.signal
		});
		await writeFile(marker, `${new Date().toISOString()}\n`);
		opts.log('Playwright’s browsers are ready.');
		return env;
	} catch (error) {
		if (opts.signal.aborted) throw opts.signal.reason;
		opts.log(
			`Couldn't install Playwright's browsers, so the agent may not be able to run browser tests: ${error instanceof Error ? error.message : String(error)}`
		);
		return {};
	}
}
