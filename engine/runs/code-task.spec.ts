import { describe, expect, it } from 'vitest';
import { followUpPrompt, splitTitle } from './code-task';
import type { Task } from '#lib/engine/contract.js';

describe('splitTitle', () => {
	it('reads the title line and keeps the rest as the description', () => {
		expect(
			splitTitle(
				'Title: [FHIR][webapp] hide the sidebar title when collapsed\n\nWhen the sidebar collapses to icons, only the badge shows.'
			)
		).toEqual({
			title: '[FHIR][webapp] hide the sidebar title when collapsed',
			body: 'When the sidebar collapses to icons, only the badge shows.'
		});
	});

	it('accepts the label in bold or quoted titles, and drops chat before it', () => {
		expect(splitTitle('Done!\n\n**Title:** `Fix the login redirect`\n\nBody.')).toEqual({
			title: 'Fix the login redirect',
			body: 'Body.'
		});
		expect(splitTitle('**Title**: "Add a changelog"\n\nBody.').title).toBe('Add a changelog');
	});

	it('leaves a message without one as it was', () => {
		const message = 'Title bar now hides when the sidebar collapses.\n\nMore.';
		expect(splitTitle(message)).toEqual({ title: null, body: message });
		expect(splitTitle('Title:   \n\nBody.')).toEqual({ title: null, body: 'Body.' });
	});
});

describe('followUpPrompt', () => {
	it('asks for the pull request again, for the whole change', () => {
		const prompt = followUpPrompt('Add a feature', { summary: 'Added it.' } as Task, 'Add tests');
		expect(prompt).toContain('Your summary of the work so far:\n\nAdded it.');
		expect(prompt).toMatch(/write the pull request again for the complete change/);
	});
});
