import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMode, type ModeClassifier } from './classifier';
import { createEngine } from './index';
import { tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

function setup(classifyMode: ModeClassifier) {
	return createEngine({ dataDir: dirs.make('patchwork-data-'), classifyMode });
}

describe('parseMode', () => {
	it('reads the first mode name in a reply', () => {
		expect(parseMode('explore')).toBe('explore');
		expect(parseMode('Ask.')).toBe('ask');
		expect(parseMode('The answer is: review')).toBe('review');
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

	it('sends at most 4000 characters', async () => {
		const classify = vi.fn<ModeClassifier>(async () => 'change');
		const engine = setup(classify);

		await engine.classifyMessage({ text: 'x'.repeat(10_000) });

		expect(classify.mock.calls[0][0].text).toHaveLength(4000);
	});
});
