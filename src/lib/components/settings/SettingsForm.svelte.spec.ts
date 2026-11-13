import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { EngineClient } from '#lib/engine/client.js';
import type { Settings, SettingsUpdate } from '#lib/engine/contract.js';
import SettingsForm from './SettingsForm.svelte';

const none = { source: null, encrypted: true } as const;
const sandbox = { available: true, missing: [], blocked: false, setup: false };

function fakeClient(autoModeModel: string | null, over: Partial<Settings> = {}) {
	let settings: Settings = {
		model: 'claude-opus-5-5',
		timeoutMinutes: 30,
		concurrency: 2,
		anthropicApiKey: none,
		openaiApiKey: none,
		geminiApiKey: none,
		githubToken: none,
		gitlabToken: none,
		githubClientId: { value: null, source: null },
		githubAccount: null,
		reviewAttributes: [],
		autoModeModel,
		agentSandbox: { claude: sandbox, codex: sandbox, gemini: sandbox },
		...over
	};
	const updates: SettingsUpdate[] = [];
	const client = {
		getSettings: async () => settings,
		updateSettings: async (update: SettingsUpdate) => {
			updates.push(update);
			settings = { ...settings, ...update } as Settings;
			return settings;
		},
		listTemplates: async () => []
	} as unknown as EngineClient;
	return { client, updates };
}

describe('SettingsForm.svelte', () => {
	it('saves the Auto mode model, or keyword rules only', async () => {
		const { client, updates } = fakeClient('claude-haiku-5-5');
		render(SettingsForm, { props: { client, events: () => () => {} } });

		const picker = page.getByTestId('auto-mode-model');
		await expect.element(picker).toHaveTextContent('Claude Haiku 5.5');

		await picker.click();
		await page.getByRole('option', { name: 'Keyword rules only' }).click();
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => updates.at(-1)?.autoModeModel).toBeNull();
		await expect.element(picker).toHaveTextContent('Keyword rules only');

		await picker.click();
		await page.getByRole('option', { name: 'Claude Sonnet 5.5' }).click();
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => updates.at(-1)?.autoModeModel).toBe('claude-sonnet-5-5');
	});

	it('keeps an older saved model in the list', async () => {
		const { client } = fakeClient('claude-haiku-4-5');
		render(SettingsForm, { props: { client, events: () => () => {} } });

		const picker = page.getByTestId('auto-mode-model');
		await expect.element(picker).toHaveTextContent('Claude Haiku 4.5');
		await picker.click();
		await expect.element(page.getByRole('option', { name: 'Claude Haiku 4.5' })).toBeVisible();
	});

	it('shows the command that installs the missing sandbox tools', async () => {
		const missing = {
			...sandbox,
			available: false,
			missing: ['socat'],
			install: 'sudo apt install socat'
		};
		const { client } = fakeClient('claude-haiku-5-5', {
			agentSandbox: { claude: missing, codex: sandbox, gemini: sandbox }
		});
		render(SettingsForm, { props: { client, events: () => () => {} } });

		const install = page.getByTestId('sandbox-install');
		await expect.element(install).toHaveTextContent('sudo apt install socat');
		await expect.element(page.getByRole('button', { name: 'Copy command' })).toBeVisible();
	});
});
