import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PageHeader from './PageHeader.svelte';

describe('PageHeader.svelte', () => {
	it('renders the title as the page heading with its description', async () => {
		render(PageHeader, { title: 'Repositories', description: 'Local git repositories' });

		await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Repositories');
		await expect.element(page.getByText('Local git repositories')).toBeInTheDocument();
	});
});
