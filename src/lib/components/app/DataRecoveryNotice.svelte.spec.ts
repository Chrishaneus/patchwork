import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import DataRecoveryNotice from './DataRecoveryNotice.svelte';

describe('DataRecoveryNotice.svelte', () => {
	it('says what happened to the damaged data and where it was kept', async () => {
		let dismissed = false;
		render(DataRecoveryNotice, {
			recovery: { kind: 'restored', movedTo: '/data/patchwork.db.corrupt-1', skipped: 0 },
			onDismiss: () => (dismissed = true)
		});
		const notice = page.getByTestId('data-recovery');
		await expect.element(notice).toHaveTextContent(/restored from the copy/);
		await expect.element(notice).toHaveTextContent('/data/patchwork.db.corrupt-1');

		await page.getByRole('button', { name: 'Dismiss' }).click();
		expect(dismissed).toBe(true);
	});

	it('counts the items it left out', async () => {
		render(DataRecoveryNotice, {
			recovery: { kind: 'partial', movedTo: null, skipped: 1 },
			onDismiss: () => {}
		});
		await expect
			.element(page.getByTestId('data-recovery'))
			.toHaveTextContent('1 saved item couldn’t be read and is left out.');
	});
});
