import {
	EngineError,
	type AgentName,
	type GitHubAccount,
	type Settings,
	type SettingsUpdate
} from '#lib/engine/contract.js';
import { codexSandboxSupport, setUpCodexSandbox } from '../agent/codex/index.js';
import { sandboxSupport, type SandboxSupport } from '../agent/sandbox.js';
import type { Store } from '../core/store.js';
import { cleanAttributes, defaultReviewAttributes } from '../runs/workflows.js';
import type { Credentials } from './credentials.js';

/** The Settings page: model, limits, review attributes, credentials and the GitHub App. */
export function createSettingsService(opts: {
	store: Store;
	credentials: Credentials;
	/** GitHub App client ID from the environment; one saved in Settings wins. */
	envGitHubClientId?: string;
	githubAccount: () => Promise<GitHubAccount | null>;
	onConcurrencyChange: (value: number) => void;
	/** Codex's binary, to check whether its sandbox can run here. */
	codexExecutable?: string;
}) {
	const { store, credentials } = opts;
	let sandbox: { claude: SandboxSupport; codex: SandboxSupport } | undefined;

	async function get(): Promise<Settings> {
		const { settings } = await store.read();
		const sources = await credentials.sources();
		const { encrypted } = credentials;
		return {
			model: settings.model,
			timeoutMinutes: settings.timeoutMinutes,
			concurrency: settings.concurrency,
			anthropicApiKey: { source: sources.anthropicApiKey, encrypted },
			openaiApiKey: { source: sources.openaiApiKey, encrypted },
			githubToken: { source: sources.githubToken, encrypted },
			gitlabToken: { source: sources.gitlabToken, encrypted },
			githubClientId: settings.githubClientId
				? { value: settings.githubClientId, source: 'saved' }
				: opts.envGitHubClientId
					? { value: opts.envGitHubClientId, source: 'environment' }
					: { value: null, source: null },
			githubAccount: await opts.githubAccount(),
			reviewAttributes: settings.reviewAttributes ?? defaultReviewAttributes,
			agentSandbox: (sandbox ??= {
				claude: sandboxSupport(),
				codex: codexSandboxSupport(opts.codexExecutable)
			})
		};
	}

	async function update(update: SettingsUpdate): Promise<Settings> {
		if (update.model !== undefined) {
			if (!update.model.trim()) throw new EngineError('invalid_input', 'Choose a model.');
		}
		if (update.timeoutMinutes !== undefined) {
			const t = update.timeoutMinutes;
			if (!Number.isInteger(t) || t < 1 || t > 240) {
				throw new EngineError('invalid_input', 'The time limit must be 1–240 minutes.');
			}
		}
		if (update.concurrency !== undefined) {
			const c = update.concurrency;
			if (!Number.isInteger(c) || c < 1 || c > 8) {
				throw new EngineError('invalid_input', 'Tasks at the same time must be 1–8.');
			}
		}
		const reviewAttributes =
			update.reviewAttributes !== undefined ? cleanAttributes(update.reviewAttributes) : undefined;
		await store.update((data) => {
			if (reviewAttributes) data.settings.reviewAttributes = reviewAttributes;
			if (update.model !== undefined) data.settings.model = update.model.trim();
			if (update.timeoutMinutes !== undefined) data.settings.timeoutMinutes = update.timeoutMinutes;
			if (update.concurrency !== undefined) data.settings.concurrency = update.concurrency;
		});
		if (update.anthropicApiKey !== undefined) await credentials.saveApiKey(update.anthropicApiKey);
		if (update.openaiApiKey !== undefined) await credentials.saveOpenAiKey(update.openaiApiKey);
		if (update.concurrency !== undefined) opts.onConcurrencyChange(update.concurrency);
		if (update.githubToken !== undefined) await credentials.saveGitHubToken(update.githubToken);
		if (update.gitlabToken !== undefined) await credentials.saveGitLabToken(update.gitlabToken);
		if (update.githubClientId !== undefined) {
			const id = update.githubClientId?.trim() || null;
			if (id && !/^[A-Za-z0-9._-]{8,64}$/.test(id)) {
				throw new EngineError('invalid_input', 'That doesn’t look like a GitHub App client ID.');
			}
			await store.update((data) => {
				data.settings.githubClientId = id;
			});
		}
		return get();
	}

	async function setUpAgentSandbox({ agent }: { agent: AgentName }): Promise<Settings> {
		const status = (await get()).agentSandbox[agent];
		if (agent !== 'codex' || !status.setup || !opts.codexExecutable) {
			throw new EngineError('invalid_input', 'This sandbox has nothing to set up.');
		}
		await setUpCodexSandbox(opts.codexExecutable);
		sandbox = undefined;
		return get();
	}

	return { get, update, setUpAgentSandbox };
}
