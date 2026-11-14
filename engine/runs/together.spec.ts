import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, Task } from '#lib/engine/contract.js';
import type { AgentRunInput, AgentRunner } from '../agent/runner';
import { createEngine, type Engine } from '../index';
import { createRepo, run as git, tempDirs } from '../test-helpers';
import { folderNames, splitPullRequests, togetherFollowUpPrompt } from './together-task';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

function waitFor(engine: Engine, taskId: string, statuses: Task['status'][]) {
	return new Promise<Task>((resolve) => {
		const stop = engine.subscribe((e) => {
			if (e.type === 'task.updated' && e.task.id === taskId && statuses.includes(e.task.status)) {
				stop();
				resolve(e.task);
			}
		});
	});
}

/**
 * Records each call; writes a file in every working copy and a pull request for each. `skip`:
 * folders it leaves alone, by call (the first call is 1).
 */
function acrossAgent(skip: Record<number, string[]> = {}) {
	const calls: AgentRunInput[] = [];
	const agent: AgentRunner = async (input) => {
		calls.push(input);
		const sections = [];
		for (const copy of input.workingCopies ?? []) {
			if (skip[calls.length]?.includes(copy.folder)) continue;
			writeFileSync(path.join(copy.path, `step-${calls.length}.txt`), `${copy.folder}\n`);
			sections.push(
				`Repository: ${copy.folder}\nTitle: Step ${calls.length} in ${copy.folder}\n\nWhat changed in ${copy.folder}.`
			);
		}
		return { summary: sections.join('\n\n'), costUsd: 0.1, turns: 2 };
	};
	return { agent, calls };
}

/** Waits until it is cancelled. */
const hangingAgent: AgentRunner = ({ signal }) =>
	new Promise((_, reject) => {
		if (signal.aborted) reject(new Error('aborted'));
		signal.addEventListener('abort', () => reject(new Error('aborted')));
	});

async function setup(agent: AgentRunner) {
	const engine = createEngine({
		dataDir: dirs.make('patchwork-data-'),
		runAgent: agent,
		pullRequestSyncMs: 0
	});
	const apiDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/api.git' });
	const webDir = createRepo(dirs.make(), { remote: 'https://github.com/acme/webapp.git' });
	const api = await engine.addRepository({ path: apiDir });
	const web = await engine.addRepository({ path: webDir });
	return { engine, api, web, apiDir, webDir };
}

describe('changes across repositories', () => {
	it('runs one agent across all of them, with a pull request and diff for each', async () => {
		const { agent, calls } = acrossAgent();
		const { engine, api, web, webDir } = await setup(agent);
		await engine.updateRepository({ id: web.id, checkCommand: 'test -f step-1.txt' });

		const run = await engine.startRun({
			repositoryIds: [api.id, web.id],
			instruction: 'Add OAuth2 login'
		});
		expect(run.together).toBe(true);
		const [first, second] = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['awaiting_review', 'failed']))
		);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.instruction).toBe('Add OAuth2 login');
		expect(call.workingCopies?.map((c) => c.folder)).toEqual(['api', 'webapp']);
		expect(call.cwd).toBe(path.dirname(call.workingCopies![0].path));

		expect(first).toMatchObject({
			status: 'awaiting_review',
			title: 'Step 1 in api',
			summary: 'What changed in api.',
			costUsd: 0.1,
			diffStat: { files: 1, insertions: 1, deletions: 0 }
		});
		expect(second).toMatchObject({
			status: 'awaiting_review',
			title: 'Step 1 in webapp',
			summary: 'What changed in webapp.',
			checks: { status: 'passed' },
			diffStat: { files: 1 }
		});
		// Each on its own branch, in its own working copy; the user's checkouts are untouched.
		expect(readFileSync(path.join(second.worktreePath!, 'step-1.txt'), 'utf8')).toBe('webapp\n');
		expect(git(second.worktreePath!, 'branch', '--show-current')).toBe(second.branch);
		expect(existsSync(path.join(webDir, 'step-1.txt'))).toBe(false);
	});

	it('finishes a repository the agent left alone without review, until a follow-up changes it', async () => {
		const { agent } = acrossAgent({ 1: ['api'] });
		const { engine, api, web } = await setup(agent);
		await engine.updateRepository({ id: api.id, checkCommand: 'false' });
		const run = await engine.startRun({ repositoryIds: [api.id, web.id], instruction: 'x' });
		const [untouched, changed] = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['awaiting_review', 'completed', 'failed']))
		);

		expect(untouched).toMatchObject({
			status: 'completed',
			title: null,
			checks: null,
			diffStat: { files: 0 }
		});
		expect(existsSync(untouched.worktreePath!)).toBe(true);
		expect(changed).toMatchObject({ status: 'awaiting_review', title: 'Step 1 in webapp' });

		// A follow-up from the unchanged one continues the session, and this time changes it.
		await engine.followUpTask({ taskId: untouched.id, instruction: 'The API too' });
		const [now] = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['awaiting_review', 'completed', 'failed']))
		);
		expect(now).toMatchObject({
			status: 'awaiting_review',
			title: 'Step 2 in api',
			checks: { status: 'failed' },
			diffStat: { files: 1 }
		});
	});

	it('runs separately when asked, with an agent each', async () => {
		const { agent, calls } = acrossAgent();
		const { engine, api, web } = await setup(agent);

		const run = await engine.startRun({
			repositoryIds: [api.id, web.id],
			instruction: 'x',
			separately: true
		});
		expect(run.together).toBeUndefined();
		await Promise.all(run.tasks.map((t) => waitFor(engine, t.id, ['awaiting_review', 'failed'])));
		expect(calls).toHaveLength(2);
		expect(calls.every((c) => !c.workingCopies)).toBe(true);
	});

	it('continues a follow-up in the same session, whichever repository it’s asked on', async () => {
		const { agent, calls } = acrossAgent();
		const { engine, api, web } = await setup(agent);
		const run = await engine.startRun({
			repositoryIds: [api.id, web.id],
			instruction: 'Add login'
		});
		const done = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['awaiting_review']))
		);

		await engine.followUpTask({ taskId: done[1].id, instruction: 'Add logout too' });
		const [first, second] = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['awaiting_review', 'failed']))
		);

		expect(calls).toHaveLength(2);
		expect(calls[1].workingCopies?.map((c) => c.path)).toEqual(done.map((t) => t.worktreePath));
		expect(calls[1].instruction).toContain('Add login');
		expect(calls[1].instruction).toContain('Add logout too');
		expect(calls[1].instruction).toContain('Step 1 in webapp');
		expect(first).toMatchObject({ title: 'Step 2 in api', costUsd: 0.2, diffStat: { files: 2 } });
		expect(first.followUps?.map((f) => f.instruction)).toEqual(['Add logout too']);
		expect(second).toMatchObject({ title: 'Step 2 in webapp', diffStat: { files: 2 } });
	});

	it('cancels every repository’s task from any of them', async () => {
		const { engine, api, web } = await setup(hangingAgent);
		const run = await engine.startRun({ repositoryIds: [api.id, web.id], instruction: 'x' });
		await waitFor(engine, run.tasks[1].id, ['running']);

		await engine.cancelTask({ taskId: run.tasks[1].id });
		const ended = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['cancelled', 'failed']))
		);
		expect(ended.map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
		expect(ended.every((t) => t.worktreePath && existsSync(t.worktreePath))).toBe(true);
	});

	it('fails every repository’s task when the agent fails', async () => {
		const failing: AgentRunner = async () => {
			throw new Error('Out of credits');
		};
		const { engine, api, web } = await setup(failing);
		const run = await engine.startRun({ repositoryIds: [api.id, web.id], instruction: 'x' });
		const ended = await Promise.all(
			run.tasks.map((t) => waitFor(engine, t.id, ['failed', 'cancelled']))
		);
		expect(ended.map((t) => [t.status, t.error?.message])).toEqual([
			['failed', 'Out of credits'],
			['failed', 'Out of credits']
		]);
	});
});

describe('splitPullRequests', () => {
	const folders = ['api', 'webapp'];

	it('splits the message into each repository’s title and description', () => {
		const message = [
			'Done.',
			'',
			'**Repository:** `api/`',
			'**Title:** Add the token endpoint',
			'',
			'The API side. Merge first.',
			'',
			'Repository: webapp',
			'Title: Log in with OAuth2',
			'',
			'The webapp side.'
		].join('\n');
		const { byFolder, all } = splitPullRequests(message, folders);
		expect(all).toBeNull();
		expect(byFolder.get('api')).toEqual({
			title: 'Add the token endpoint',
			body: 'The API side. Merge first.'
		});
		expect(byFolder.get('webapp')).toEqual({
			title: 'Log in with OAuth2',
			body: 'The webapp side.'
		});
	});

	it('leaves out repositories it doesn’t name, and shares a message without sections', () => {
		const named = splitPullRequests('Repository: api\nTitle: Only the API\n\nBody', folders);
		expect([...named.byFolder.keys()]).toEqual(['api']);

		const shared = splitPullRequests('Title: One for all\n\nBoth changed.', folders);
		expect(shared.all).toEqual({ title: 'One for all', body: 'Both changed.' });
	});
});

describe('folderNames', () => {
	it('names each working copy after its repository, made unique', () => {
		const repos = [{ name: 'API' }, { name: 'web app' }, { name: 'api' }] as never;
		expect(folderNames(repos)).toEqual(['api', 'web-app', 'api-2']);
	});
});

describe('togetherFollowUpPrompt', () => {
	it('gives the request, the pull requests so far, failed checks and the new ask', () => {
		const lead = {
			repositoryName: 'api',
			title: 'Add tokens',
			summary: 'The API side.',
			followUps: [
				{ instruction: 'Earlier ask', at: '' },
				{ instruction: 'Now', at: '' }
			]
		} as Task;
		const web = {
			repositoryName: 'webapp',
			summary: 'The webapp side.',
			checks: { status: 'failed', command: 'npm test', output: 'boom' }
		} as Task;
		const run = { instruction: 'Add OAuth2', tasks: [lead, web] } as Run;
		const prompt = togetherFollowUpPrompt(run, lead, 'Now');
		expect(prompt).toContain('Add OAuth2');
		expect(prompt).toContain('- Earlier ask');
		expect(prompt).toContain('api: Add tokens\n\nThe API side.');
		expect(prompt).toContain('webapp: The webapp side.');
		expect(prompt).toContain("webapp's checks (`npm test`) failed");
		expect(prompt).toContain('Now do this as well:\n\nNow');
	});
});
