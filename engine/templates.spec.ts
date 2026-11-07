import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './index';
import { tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('templates', () => {
	it('creates, lists by name, updates and deletes templates', async () => {
		const engine = createEngine({ dataDir: dirs.make('patchwork-data-'), pullRequestSyncMs: 0 });
		const b = await engine.saveTemplate({
			name: 'Upgrade deps',
			instruction: 'Upgrade all dependencies.'
		});
		await engine.saveTemplate({ name: 'Add changelog', instruction: 'Add a changelog entry.' });
		expect((await engine.listTemplates({})).map((t) => t.name)).toEqual([
			'Add changelog',
			'Upgrade deps'
		]);

		await engine.saveTemplate({
			id: b.id,
			name: 'Upgrade dependencies',
			instruction: 'Upgrade them.'
		});
		await expect(engine.saveTemplate({ name: ' ', instruction: 'x' })).rejects.toMatchObject({
			code: 'invalid_input'
		});
		await engine.deleteTemplate({ id: b.id });
		expect(await engine.listTemplates({})).toEqual([
			expect.objectContaining({ name: 'Add changelog', instruction: 'Add a changelog entry.' })
		]);
	});
});
