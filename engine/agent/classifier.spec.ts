import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyByRules, parseMode, type ModeClassifier } from './classifier';
import { createEngine } from '../index';
import { tempDirs } from '../test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

function setup(classifyMode: ModeClassifier) {
	return createEngine({ dataDir: dirs.make('patchwork-data-'), classifyMode });
}

describe('parseMode', () => {
	it('accepts a reply that is exactly one mode name', () => {
		expect(parseMode('explore')).toBe('explore');
		expect(parseMode(' Ask.\n')).toBe('ask');
		expect(parseMode('**review**')).toBe('review');
		expect(parseMode('`change`')).toBe('change');
	});

	it('refuses anything longer, rather than guessing', () => {
		expect(parseMode("This isn't a change, it's an ask")).toBeNull();
		expect(parseMode('The answer is: review')).toBeNull();
		expect(parseMode('ask or explore')).toBeNull();
		expect(parseMode('changes')).toBeNull();
		expect(parseMode('')).toBeNull();
	});
});

describe('classifyMessage', () => {
	it('lets the model decide', async () => {
		const classify = vi.fn<ModeClassifier>(async () => 'ask');
		const engine = setup(classify);

		// The keyword rules would call this a change.
		const result = await engine.classifyMessage({ text: '  Walk through the login flow  ' });

		expect(result).toEqual({ mode: 'ask', source: 'ai' });
		expect(classify).toHaveBeenCalledWith(
			expect.objectContaining({ text: 'Walk through the login flow' })
		);
	});

	it('answers a pull request link or an empty message without the model', async () => {
		const classify = vi.fn<ModeClassifier>(async () => 'change');
		const engine = setup(classify);

		expect(
			await engine.classifyMessage({ text: 'explain https://github.com/acme/w/pull/12' })
		).toEqual({ mode: 'review', source: 'rules' });
		expect(await engine.classifyMessage({ text: '  ' })).toEqual({
			mode: 'change',
			source: 'rules'
		});
		expect(classify).not.toHaveBeenCalled();
	});

	it('falls back to the keyword rules when the model fails', async () => {
		const engine = setup(async () => {
			throw new Error('not signed in');
		});

		expect(await engine.classifyMessage({ text: 'How should we add caching?' })).toEqual({
			mode: 'explore',
			source: 'rules'
		});
	});

	it('asks the model from Settings, or only the keyword rules when it is turned off', async () => {
		const classify = vi.fn<ModeClassifier>(async () => 'ask');
		const engine = setup(classify);
		expect((await engine.getSettings({})).autoModeModel).toBe('claude-haiku-5-5');

		await engine.classifyMessage({ text: 'Walk through the login flow' });
		expect(classify.mock.calls[0][0].model).toBe('claude-haiku-5-5');

		await engine.updateSettings({ autoModeModel: ' claude-sonnet-5-5 ' });
		await engine.classifyMessage({ text: 'Walk through the login flow' });
		expect(classify.mock.calls[1][0].model).toBe('claude-sonnet-5-5');

		const off = await engine.updateSettings({ autoModeModel: null });
		expect(off.autoModeModel).toBeNull();
		expect(await engine.classifyMessage({ text: 'How should we add caching?' })).toEqual({
			mode: 'explore',
			source: 'rules'
		});
		expect(classify).toHaveBeenCalledTimes(2);
	});

	it('refuses an Auto mode model that Claude Code can’t run', async () => {
		const engine = setup(classifyByRules);
		for (const autoModeModel of ['gpt-6-luna', '  ', 42 as unknown as string]) {
			await expect(engine.updateSettings({ autoModeModel })).rejects.toMatchObject({
				code: 'invalid_input'
			});
		}
		expect((await engine.getSettings({})).autoModeModel).toBe('claude-haiku-5-5');
	});

	it('sends at most 4000 characters', async () => {
		const classify = vi.fn<ModeClassifier>(async () => 'change');
		const engine = setup(classify);

		await engine.classifyMessage({ text: 'x'.repeat(10_000) });

		expect(classify.mock.calls[0][0].text).toHaveLength(4000);
	});
});
