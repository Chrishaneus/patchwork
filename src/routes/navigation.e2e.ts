import { expect, test } from '@playwright/test';

test('dashboard renders with the sidebar', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
	await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
		'aria-current',
		'page'
	);
});

test('sidebar navigates between sections', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page).toHaveURL(/\/repositories$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Repositories');

	await page.getByRole('link', { name: 'Runs' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Runs');
});

test('Spanish routes keep the locale while navigating', async ({ page }) => {
	await page.goto('/es');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Panel');
	await page.getByRole('link', { name: 'Repositorios' }).click();
	await expect(page).toHaveURL(/\/es\/repositories$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Repositorios');
});
