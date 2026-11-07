import type { SecretStore } from '../core/secrets.js';

/** Names of the saved secrets. */
const API_KEY = 'anthropicApiKey';
const GITHUB_TOKEN = 'githubToken';
const GITLAB_TOKEN = 'gitlabToken';

type Source = 'saved' | 'environment' | null;

/**
 * The Anthropic API key and the GitHub and GitLab tokens: saved in Settings first, then the
 * environment. GitHub sign-in comes before both for GitHub.
 */
export function createCredentials(
	secrets: SecretStore,
	opts: { signedInGitHubToken: () => Promise<string | null> }
) {
	const envApiKey = () => process.env.ANTHROPIC_API_KEY || null;
	const envGitHubToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
	const envGitLabToken = () => process.env.GITLAB_TOKEN || null;
	const source = async (name: string, env: () => string | null): Promise<Source> =>
		(await secrets.get(name)) ? 'saved' : env() ? 'environment' : null;
	const save = (name: string, value: string | null) => secrets.set(name, value?.trim() || null);

	return {
		encrypted: secrets.encrypted,
		getApiKey: async () => (await secrets.get(API_KEY)) ?? process.env.ANTHROPIC_API_KEY ?? null,
		getGitHubToken: async () =>
			(await opts.signedInGitHubToken()) ?? (await secrets.get(GITHUB_TOKEN)) ?? envGitHubToken(),
		getGitLabToken: async () => (await secrets.get(GITLAB_TOKEN)) ?? envGitLabToken(),
		/** Where each one comes from, for the Settings page; never the values themselves. */
		sources: async () => ({
			anthropicApiKey: await source(API_KEY, envApiKey),
			githubToken: await source(GITHUB_TOKEN, envGitHubToken),
			gitlabToken: await source(GITLAB_TOKEN, envGitLabToken)
		}),
		/** Save a value, or delete it with null or an empty string. */
		saveApiKey: (value: string | null) => save(API_KEY, value),
		saveGitHubToken: (value: string | null) => save(GITHUB_TOKEN, value),
		saveGitLabToken: (value: string | null) => save(GITLAB_TOKEN, value)
	};
}

export type Credentials = ReturnType<typeof createCredentials>;
