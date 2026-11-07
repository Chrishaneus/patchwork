import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunner } from './runner.js';

/**
 * A scripted agent for end-to-end tests (selected with PATCHWORK_TEST_AGENT). It never calls a model.
 * - "edit": logs a few steps, writes a file and finishes.
 * - "hang": waits until it is cancelled.
 */
export function createTestAgent(mode: string): AgentRunner {
	return async ({ cwd, instruction, signal, log, mode: workflow, attributes }) => {
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
			const json = { scores, summary: 'The change is small and clear.', verdict: 'comment' };
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
		log({ kind: 'tool', text: 'Write CHANGELOG.md' });
		await writeFile(path.join(cwd, 'CHANGELOG.md'), `# Changelog\n\n- ${instruction}\n`);
		const summary = `Added a changelog entry for "${instruction}".`;
		log({ kind: 'result', text: summary });
		return { summary, costUsd: 0.0123, turns: 2 };
	};
}
