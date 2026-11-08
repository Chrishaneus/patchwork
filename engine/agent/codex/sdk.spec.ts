import { describe, expect, it } from 'vitest';
import { describeCodexEvent } from './sdk';

describe('describeCodexEvent', () => {
	const cwd = '/wt';

	it('logs commands when they start, without the shell wrapper', () => {
		const command = {
			id: '1',
			type: 'command_execution' as const,
			command: "/bin/bash -lc 'npm test'",
			aggregated_output: '',
			status: 'in_progress' as const
		};
		expect(describeCodexEvent({ type: 'item.started', item: command }, cwd)).toEqual([
			{ kind: 'tool', text: '$ npm test' }
		]);
		expect(
			describeCodexEvent({ type: 'item.completed', item: { ...command, status: 'completed' } }, cwd)
		).toEqual([]);
	});

	it('logs messages, file changes and errors', () => {
		expect(
			describeCodexEvent(
				{ type: 'item.completed', item: { id: '2', type: 'agent_message', text: ' Done. ' } },
				cwd
			)
		).toEqual([{ kind: 'assistant', text: 'Done.' }]);
		expect(
			describeCodexEvent(
				{
					type: 'item.completed',
					item: {
						id: '3',
						type: 'file_change',
						status: 'completed',
						changes: [
							{ path: '/wt/src/a.ts', kind: 'update' },
							{ path: 'src/b.ts', kind: 'add' }
						]
					}
				},
				cwd
			)
		).toEqual([
			{ kind: 'tool', text: 'Edit src/a.ts' },
			{ kind: 'tool', text: 'Write src/b.ts' }
		]);
		expect(
			describeCodexEvent(
				{ type: 'item.completed', item: { id: '4', type: 'error', message: 'Patch failed' } },
				cwd
			)
		).toEqual([{ kind: 'error', text: 'Patch failed' }]);
	});
});
