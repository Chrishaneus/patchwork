import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { RepositoryChoices } from '#lib/components/repositories/repository-choices.svelte.js';
import RepositoryPicker from './RepositoryPicker.svelte';

const repo = (name: string) => ({ id: name, name, detail: `acme/${name}`, onFirstRun: false });
const choices = {
	loaded: true,
	available: ['alpha', 'beta', 'gamma', 'delta'].map(repo)
} as unknown as RepositoryChoices;

const order = () =>
	[...document.querySelectorAll('[data-testid="repository-list"] .font-medium')].map(
		(el) => el.textContent
	);

describe('RepositoryPicker.svelte', () => {
	it('moves selected repositories to the top, in the order they were picked', async () => {
		render(RepositoryPicker, { choices, selected: [] });
		expect(order()).toEqual(['alpha', 'beta', 'gamma', 'delta']);

		await page.getByRole('checkbox', { name: /delta/ }).click();
		await page.getByRole('checkbox', { name: /gamma/ }).click();
		await expect.poll(order).toEqual(['delta', 'gamma', 'alpha', 'beta']);

		// Unticked, it goes back to its usual place.
		await page.getByRole('checkbox', { name: /delta/ }).click();
		await expect.poll(order).toEqual(['gamma', 'alpha', 'beta', 'delta']);
	});
});
