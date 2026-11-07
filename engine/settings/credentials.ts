import type { AgentProvider } from '#lib/models.js';
import type { SecretStore } from '../core/secrets.js';

/** Names of the saved secrets. */
const API_KEY = 'anthropicApiKey';
const OPENAI_API_KEY = 'openaiApiKey';
const GITHUB_TOKEN = 'githubToken';
const GITLAB_TOKEN = 'gitlabToken';

type Source = 'saved' | 'environment' | null;

/**
 * The Anthropic and OpenAI API keys and the GitHub and GitLab tokens: saved in Settings first,
 * then the environment. GitHub sign-in comes before both for GitHub.
 */
export function createCredentials(
	secrets: SecretStore,
	opts: { signedInGitHubToken: () => Promise<string | null> }
) {
	const envApiKey = () => process.env.ANTHROPIC_API_KEY || null;
	const envOpenAiKey = () => process.env.OPENAI_API_KEY || null;
	const envGitHubToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
	const envGitLabToken = () => process.env.GITLAB_TOKEN || null;
	const source = async (name: string, env: () => string | null): Promise<Source> =>
		(await secrets.get(name)) ? 'saved' : env() ? 'environment' : null;
	const save = (name: string, value: string | null) => secrets.set(name, value?.trim() || null);

	return {
		encrypted: secrets.encrypted,
		/** The key for the agent's provider; null means the agent's own login (Claude, Codex). */
		getApiKey: async (provider: AgentProvider = 'anthropic') =>
			provider === 'openai'
				? ((await secrets.get(OPENAI_API_KEY)) ?? envOpenAiKey())
				: ((await secrets.get(API_KEY)) ?? envApiKey()),
		getGitHubToken: async () =>
			(await opts.signedInGitHubToken()) ?? (await secrets.get(GITHUB_TOKEN)) ?? envGitHubToken(),
		getGitLabToken: async () => (await secrets.get(GITLAB_TOKEN)) ?? envGitLabToken(),
		/** Where each one comes from, for the Settings page; never the values themselves. */
		sources: async () => ({
			anthropicApiKey: await source(API_KEY, envApiKey),
			openaiApiKey: await source(OPENAI_API_KEY, envOpenAiKey),
			githubToken: await source(GITHUB_TOKEN, envGitHubToken),
			gitlabToken: await source(GITLAB_TOKEN, envGitLabToken)
		}),
		/** Save a value, or delete it with null or an empty string. */
		saveApiKey: (value: string | null) => save(API_KEY, value),
		saveOpenAiKey: (value: string | null) => save(OPENAI_API_KEY, value),
		saveGitHubToken: (value: string | null) => save(GITHUB_TOKEN, value),
		saveGitLabToken: (value: string | null) => save(GITLAB_TOKEN, value)
	};
}

export type Credentials = ReturnType<typeof createCredentials>;
