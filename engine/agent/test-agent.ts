import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunner } from './runner.js';

/**
 * A scripted agent for end-to-end tests (selected with PATCHWORK_TEST_AGENT). It never calls a model.
 * - "edit": logs a few steps, writes a file and finishes. When the instruction mentions "outside
 *   the sandbox", it first asks to run `docker compose up -d` there. Across repositories, it
 *   writes the file in each and answers with a pull request per repository.
 * - "hang": waits until it is cancelled.
 * Reviews answer with scores and one suggestion on the first changed file, per pull request.
 */
/**
 * A review comment on the first line of the first file the pull request changes, suggesting it
 * in capitals; none when there's nothing to comment on.
 */
function suggestOn(dir: string, base: string | undefined) {
	if (!base) return [];
	try {
		const file = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
			cwd: dir,
			encoding: 'utf8'
		})
			.split('\n')
			.find(Boolean);
		if (!file) return [];
		const first = readFileSync(path.join(dir, file), 'utf8').split('\n')[0];
		return [{ path: file, line: 1, body: 'Say it louder.', suggestion: first.toUpperCase() }];
	} catch {
		return [];
	}
}

export function createTestAgent(mode: string): AgentRunner {
	return async ({
		cwd,
		instruction,
		signal,
		log,
		mode: workflow,
		attributes,
		requestApproval,
		workingCopies
	}) => {
		const wait = (ms: number) =>
			new Promise<void>((resolve, reject) => {
				if (signal.aborted) return reject(new Error('aborted'));
				const timer = setTimeout(resolve, ms);
				signal.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new Error('aborted'));
				});
			});

		log({ kind: 'info', text: 'Agent started with test-agent' });
		log({ kind: 'assistant', text: `Working on: ${instruction}` });
		if (mode === 'hang') {
			await wait(10 * 60_000);
		}
		await wait(800);

		// Read-only workflows answer with the JSON the app expects, without touching files.
		if (workflow === 'review') {
			log({ kind: 'tool', text: '$ git diff' });
			const scores = (attributes ?? []).map((a, i) => ({
				attribute: a.name,
				score: 5 - (i % 3),
				explanation: `${a.name}: checked by the test agent.`
			}));
			// Several pull requests: each listed with its folder and diff command.
			const listed = [
				...instruction.matchAll(/^- (\S+) in `([^`]+)`.*?`git -C \S+ diff (\w+)\.\.\.HEAD`/gm)
			];
			const json =
				listed.length > 0
					? {
							scores,
							summary: 'The pull requests fit together.',
							verdict: 'comment',
							pullRequests: listed.map(([, url, folder, base]) => ({
								url,
								scores,
								summary: `Reviewed ${url}.`,
								verdict: 'comment',
								comments: suggestOn(path.join(cwd, folder), base)
							}))
						}
					: {
							scores,
							summary: 'The change is small and clear.',
							verdict: 'comment',
							comments: suggestOn(cwd, /git diff (\w+)\.\.\.HEAD/.exec(instruction)?.[1])
						};
			const summary = `Reviewed the pull request.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
			log({ kind: 'result', text: summary });
			return { summary, costUsd: 0.02, turns: 3 };
		}
		if (workflow === 'ask') {
			log({ kind: 'tool', text: 'Read README.md' });
			const summary = [
				`Here is what I found about: ${instruction.split('\n')[0]}`,
				'## Components',
				'| Path | Role |\n|---|---|\n| `src/` | The **app** |\n| `test/` | Tests |',
				'1. Read `README.md`\n2. Run `npm test`',
				'```sh\nnpm test\n```'
			].join('\n\n');
			log({ kind: 'result', text: summary });
			return { summary, costUsd: 0.01, turns: 2 };
		}
		if (workflow === 'explore') {
			log({ kind: 'tool', text: 'Grep TODO' });
			const json = {
				approaches: [
					{
						title: 'Add a small module',
						summary: 'Put the feature in its own module.',
						details: 'Create a module and call it from the entry point.',
						files: ['src/feature.ts'],
						pros: ['Isolated', 'Easy to test'],
						cons: ['One more file'],
						effort: 'small'
					},
					{
						title: 'Extend the existing code',
						summary: 'Grow the current implementation.',
						details: 'Add a branch to the existing logic.',
						files: ['src/index.ts'],
						pros: ['No new files'],
						cons: ['Harder to test'],
						effort: 'medium'
					}
				],
				recommendation: 'Add a small module: it keeps the change isolated.'
			};
			const summary = `Explored the codebase.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
			log({ kind: 'result', text: summary });
			return { summary, costUsd: 0.015, turns: 4 };
		}
		// An instruction mentioning the sandbox makes it ask to run a command outside it.
		let outside = '';
		if (/outside the sandbox/i.test(instruction) && requestApproval) {
			const command = 'docker compose up -d';
			const allowed = await requestApproval({
				command,
				reason: 'The tests need the database container.'
			});
			if (allowed) log({ kind: 'tool', text: `$ ${command}` });
			outside = allowed ? ' Started the database.' : ' Couldn’t start the database.';
		}
		// Across repositories: a changelog entry in each, and a pull request for each.
		if (workingCopies && workingCopies.length > 1) {
			const sections = [];
			for (const copy of workingCopies) {
				log({ kind: 'tool', text: `Write ${copy.folder}/CHANGELOG.md` });
				await writeFile(path.join(copy.path, 'CHANGELOG.md'), `# Changelog\n\n- ${instruction}\n`);
				sections.push(
					`Repository: ${copy.folder}\nTitle: Add a changelog entry to ${copy.folder}\n\nAdded a changelog entry to ${copy.folder} for "${instruction}", with the other repositories' entries.`
				);
			}
			const summary = sections.join('\n\n');
			log({ kind: 'result', text: summary });
			return { summary, costUsd: 0.0123, turns: 2 };
		}
		log({ kind: 'tool', text: 'Write CHANGELOG.md' });
		await writeFile(path.join(cwd, 'CHANGELOG.md'), `# Changelog\n\n- ${instruction}\n`);
		const summary = `Added a changelog entry for "${instruction}".${outside}`;
		log({ kind: 'result', text: summary });
		return { summary, costUsd: 0.0123, turns: 2 };
	};
}
