import { describe, expect, it } from 'vitest';
import { findModel, modelProviders } from './models';

describe('model catalogue', () => {
	it('finds current and older models with their provider', () => {
		expect(findModel('claude-opus-5-5')).toMatchObject({
			provider: { id: 'anthropic' },
			model: { name: 'Claude Opus 5.5' }
		});
		expect(findModel('claude-opus-4-8')?.model.name).toBe('Claude Opus 4.8');
		expect(findModel('my-custom-model')).toBeUndefined();
	});

	it('has unique model IDs', () => {
		const ids = modelProviders.flatMap((p) => [...p.models, ...p.older].map((m) => m.id));
		expect(new Set(ids).size).toBe(ids.length);
	});
});
