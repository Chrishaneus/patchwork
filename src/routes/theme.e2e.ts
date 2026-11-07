import { expect, test } from '@playwright/test';

const isDark = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.classList.contains('dark'));

test('dark is the default, and the choice is remembered', async ({ page }) => {
	// Even before the app's JavaScript loads, the page is dark (no light flash).
	await page.route('**/_app/**', (route) => route.abort());
	await page.goto('/');
	expect(await isDark(page)).toBe(true);
	await page.unroute('**/_app/**');

	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
	expect(await isDark(page)).toBe(true);
	const theme = page.getByRole('group', { name: 'Theme' });
	await expect(theme.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');

	await theme.getByRole('button', { name: 'Light' }).click();
	await expect.poll(() => isDark(page)).toBe(false);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
	expect(await isDark(page)).toBe(false);
	await expect(theme.getByRole('button', { name: 'Light' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('System follows the operating system setting', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/');
	await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }).click();
	await expect.poll(() => isDark(page)).toBe(false);

	await page.emulateMedia({ colorScheme: 'dark' });
	await expect.poll(() => isDark(page)).toBe(true);
});
