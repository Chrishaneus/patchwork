import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLegacyEnv, migrateDataDir } from './env';
import { tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('the rename from AI Tool to Patchwork', () => {
	it('maps old AI_TOOL_* settings to PATCHWORK_*, without overriding new ones', () => {
		const env: NodeJS.ProcessEnv = {
			AI_TOOL_TOKEN: 'old',
			AI_TOOL_REPOS: '/old',
			PATCHWORK_REPOS: '/new',
			OTHER: 'x'
		};
		applyLegacyEnv(env);
		expect(env.PATCHWORK_TOKEN).toBe('old');
		expect(env.PATCHWORK_REPOS).toBe('/new');
		expect(env.OTHER).toBe('x');
	});

	it('moves the old data folder once', () => {
		const base = dirs.make('patchwork-migrate-');
		const from = path.join(base, 'ai-tool', 'engine');
		const to = path.join(base, 'patchwork', 'engine');
		mkdirSync(from, { recursive: true });
		writeFileSync(path.join(from, 'data.json'), '{"version":1}');

		expect(migrateDataDir(from, to)).toBe(true);
		expect(readFileSync(path.join(to, 'data.json'), 'utf8')).toBe('{"version":1}');
		expect(existsSync(from)).toBe(false);

		// Nothing to move the second time, and existing new data is never overwritten.
		mkdirSync(from, { recursive: true });
		expect(migrateDataDir(from, to)).toBe(false);
	});
});
