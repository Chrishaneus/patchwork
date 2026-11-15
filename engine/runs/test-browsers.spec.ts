import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '#lib/engine/contract.js';
import { guidance, type AgentRunInput, type AgentRunner } from '../agent/runner';
import { createEngine, type Engine } from '../index';
import { createRepo, run as git, tempDirs } from '../test-helpers';
import {
	browsersFor,
	playwrightVersion,
	prepareTestBrowsers,
	readyBrowsersEnv,
	type BrowserInstall
} from './test-browsers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** A folder with these files in it. */
function folder(files: Record<string, string>) {
	const dir = dirs.make();
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
	return dir;
}

/** Records what it's asked to install, and fails when told to. */
function fakeInstaller(fail = false) {
	const installs: BrowserInstall[] = [];
	const install = async (request: BrowserInstall) => {
		installs.push(request);
		if (fail) throw new Error('Download failure');
	};
	return { install, installs };
}

describe('playwrightVersion', () => {
	it('reads the version from each kind of lockfile', () => {
		const npm = {
			packages: {
				'node_modules/@playwright/test': { version: '1.48.0' },
				'node_modules/playwright-core': { version: '1.48.2' }
			}
		};
		expect(playwrightVersion(folder({ 'package-lock.json': JSON.stringify(npm) }))).toBe('1.48.2');
		expect(
			playwrightVersion(
				folder({ 'package-lock.json': '{"dependencies":{"playwright":{"version":"1.40.1"}}}' })
			)
		).toBe('1.40.1');
		expect(
			playwrightVersion(
				folder({
					'pnpm-lock.yaml': 'packages:\n\n  playwright-core@1.49.1:\n    resolution: {}\n'
				})
			)
		).toBe('1.49.1');
		expect(
			playwrightVersion(
				folder({ 'pnpm-lock.yaml': 'packages:\n  /@playwright/test@1.41.0:\n    dev: true\n' })
			)
		).toBe('1.41.0');
		expect(
			playwrightVersion(
				folder({
					'yarn.lock': '"@playwright/test@^1.47.0":\n  version "1.47.2"\n  resolved "x"\n'
				})
			)
		).toBe('1.47.2');
		expect(
			playwrightVersion(
				folder({
					'bun.lock': '{ "packages": { "playwright-core": ["playwright-core@1.50.0", ""] } }'
				})
			)
		).toBe('1.50.0');
	});

	it('falls back to package.json, and ignores repositories without Playwright', () => {
		expect(
			playwrightVersion(
				folder({ 'package.json': '{"devDependencies":{"@playwright/test":"^1.48.0"}}' })
			)
		).toBe('1.48.0');
		expect(
			playwrightVersion(folder({ 'package.json': '{"dependencies":{"vite":"^6.0.0"}}' }))
		).toBe(null);
		expect(playwrightVersion(folder({}))).toBe(null);
	});

	it('takes only a plain version, so a lockfile can’t name another package to run', () => {
		const npm = { packages: { 'node_modules/playwright': { version: 'npm:evil@1.0.0' } } };
		expect(playwrightVersion(folder({ 'package-lock.json': JSON.stringify(npm) }))).toBe(null);
		expect(
			playwrightVersion(folder({ 'package.json': '{"devDependencies":{"playwright":"latest"}}' }))
		).toBe(null);
	});
});

describe('browsersFor', () => {
	it('installs Chromium, plus Firefox and WebKit when the config uses them', () => {
		expect(browsersFor(folder({}))).toEqual(['chromium']);
		expect(
			browsersFor(
				folder({
					'playwright.config.ts':
						"projects: [{ use: devices['Desktop Firefox'] }, { use: devices['Desktop Safari'] }]"
				})
			)
		).toEqual(['chromium', 'firefox', 'webkit']);
	});
});

describe('prepareTestBrowsers', () => {
	const repo = () =>
		folder({ 'package.json': '{"devDependencies":{"@playwright/test":"1.48.2"}}' });

	it('installs once per version, then only points at the browsers', async () => {
		const dir = repo();
		const browsersDir = dirs.make('patchwork-browsers-');
		const { install, installs } = fakeInstaller();
		const notes: string[] = [];
		const prepare = () =>
			prepareTestBrowsers({
				dir,
				browsersDir,
				install,
				log: (text) => notes.push(text),
				signal: new AbortController().signal
			});

		expect(readyBrowsersEnv(dir, browsersDir)).toEqual({});
		expect(await prepare()).toEqual({ PLAYWRIGHT_BROWSERS_PATH: browsersDir });
		expect(await prepare()).toEqual({ PLAYWRIGHT_BROWSERS_PATH: browsersDir });
		expect(installs.map((i) => [i.version, i.browsers, i.browsersDir])).toEqual([
			['1.48.2', ['chromium'], browsersDir]
		]);
		expect(notes[0]).toContain('Installing Playwright 1.48.2');
		expect(readyBrowsersEnv(dir, browsersDir)).toEqual({ PLAYWRIGHT_BROWSERS_PATH: browsersDir });
	});

	it('carries on without them when installing fails', async () => {
		const notes: string[] = [];
		const env = await prepareTestBrowsers({
			dir: repo(),
			browsersDir: dirs.make('patchwork-browsers-'),
			install: fakeInstaller(true).install,
			log: (text) => notes.push(text),
			signal: new AbortController().signal
		});
		expect(env).toEqual({});
		expect(notes.at(-1)).toMatch(/^Couldn't install Playwright's browsers.*: Download failure$/);
	});
});

describe('Playwright browsers in a change', () => {
	function waitFor(engine: Engine, taskId: string) {
		return new Promise<Task>((resolve) => {
			const stop = engine.subscribe((e) => {
				if (
					e.type === 'task.updated' &&
					e.task.id === taskId &&
					['awaiting_review', 'failed'].includes(e.task.status)
				) {
					stop();
					resolve(e.task);
				}
			});
		});
	}

	it('installs them before the agent starts, for the agent and the checks', async () => {
		const inputs: AgentRunInput[] = [];
		const agent: AgentRunner = async (input) => {
			inputs.push(input);
			writeFileSync(path.join(input.cwd, 'step.txt'), `${inputs.length}\n`);
			return { summary: 'Done.', costUsd: 0, turns: 1 };
		};
		const { install, installs } = fakeInstaller();
		const dataDir = dirs.make('patchwork-data-');
		const engine = createEngine({ dataDir, runAgent: agent, installBrowsers: install });
		const repoDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/web.git' });
		writeFileSync(
			path.join(repoDir, 'package.json'),
			'{"devDependencies":{"@playwright/test":"1.48.2"}}'
		);
		git(repoDir, 'add', '.');
		git(repoDir, 'commit', '-q', '-m', 'Add Playwright');
		const repo = await engine.addRepository({ path: repoDir });
		await engine.updateRepository({
			id: repo.id,
			checkCommand: 'test -n "$PLAYWRIGHT_BROWSERS_PATH"'
		});

		const browsersDir = path.join(dataDir, 'browsers');
		for (const instruction of ['First', 'Second']) {
			const run = await engine.startRun({ repositoryIds: [repo.id], instruction });
			const done = await waitFor(engine, run.tasks[0].id);
			expect(done.checks?.status).toBe('passed');
		}
		expect(installs).toHaveLength(1);
		expect(inputs.map((i) => i.env?.PLAYWRIGHT_BROWSERS_PATH)).toEqual([browsersDir, browsersDir]);
		expect(existsSync(browsersDir)).toBe(true);
	});

	it('leaves repositories without Playwright alone', async () => {
		const inputs: AgentRunInput[] = [];
		const agent: AgentRunner = async (input) => {
			inputs.push(input);
			return { summary: 'Done.', costUsd: 0, turns: 1 };
		};
		const { install, installs } = fakeInstaller();
		const engine = createEngine({
			dataDir: dirs.make('patchwork-data-'),
			runAgent: agent,
			installBrowsers: install
		});
		const repo = await engine.addRepository({
			path: createRepo(dirs.make(), { remote: 'https://github.com/acme/api.git' })
		});
		const run = await engine.startRun({ repositoryIds: [repo.id], instruction: 'x' });
		await waitFor(engine, run.tasks[0].id);
		expect(installs).toHaveLength(0);
		expect(inputs[0].env).toEqual({});
	});
});

describe('guidance', () => {
	const input = {
		cwd: '/w',
		instruction: 'x',
		repository: { name: 'web', slug: 'acme/web' },
		branch: 'b',
		baseBranch: 'main'
	} as AgentRunInput;

	it('tells the agent the browsers are ready only when they are', () => {
		expect(guidance(input)).not.toContain('PLAYWRIGHT_BROWSERS_PATH');
		const ready = guidance({ ...input, env: { PLAYWRIGHT_BROWSERS_PATH: '/data/browsers' } });
		expect(ready).toContain('without `playwright install`');
		expect(ready).toContain('services running on this machine');
	});
});
