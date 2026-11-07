import {
	EngineError,
	type GitHubAccount,
	type GitHubLoginStart,
	type GitHubRepository
} from '#lib/engine/contract.js';
import type { EngineEvents } from '../core/events.js';
import type { SecretStore } from '../core/secrets.js';

/**
 * "Sign in with GitHub" using the OAuth device flow of a GitHub App: the user enters a short code
 * on github.com, and we poll until they approve. Only the app's public client ID is needed — no
 * client secret, so it works the same in the desktop app, on a server and on phones.
 *
 * The GitHub App should have "Expire user authorization tokens" turned off: refreshing an
 * expiring token needs the client secret, which a desktop or mobile app can't keep. If a token
 * does expire, the user is signed out and asked to sign in again.
 */

const OAUTH_SECRET = 'githubOAuth';

interface StoredLogin {
	token: string;
	login: string;
	avatarUrl: string | null;
	/** ISO time, or null for tokens that don't expire. */
	expiresAt: string | null;
}

export interface GitHubAuthOptions {
	/** https://github.com, or a test server. */
	webUrl: string;
	/** https://api.github.com, or a test server. */
	apiUrl: string;
	getClientId: () => Promise<string | null>;
	secrets: SecretStore;
	events: EngineEvents;
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve();
		});
	});

export function createGitHubAuth(opts: GitHubAuthOptions) {
	let pending: AbortController | null = null;

	async function postForm(url: string, body: Record<string, string>) {
		const res = await fetch(url, {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body),
			signal: AbortSignal.timeout(30_000)
		});
		return (await res.json().catch(() => ({}))) as Record<string, unknown>;
	}

	async function api(path: string, token: string) {
		const res = await fetch(`${opts.apiUrl.replace(/\/$/, '')}${path}`, {
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${token}`,
				'x-github-api-version': '2022-11-28',
				'user-agent': 'patchwork'
			},
			signal: AbortSignal.timeout(30_000)
		});
		return { status: res.status, data: (await res.json().catch(() => null)) as unknown };
	}

	async function stored(): Promise<StoredLogin | null> {
		const raw = await opts.secrets.get(OAUTH_SECRET);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as StoredLogin;
		} catch {
			return null;
		}
	}

	/** Poll GitHub until the user approves, denies, or the code expires. */
	async function poll(
		clientId: string,
		deviceCode: string,
		intervalMs: number,
		expiresAt: number,
		signal: AbortSignal
	) {
		let wait = intervalMs;
		while (!signal.aborted && Date.now() < expiresAt) {
			await sleep(wait, signal);
			if (signal.aborted) return;
			let result: Record<string, unknown>;
			try {
				result = await postForm(`${opts.webUrl}/login/oauth/access_token`, {
					client_id: clientId,
					device_code: deviceCode,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
				});
			} catch {
				continue; // Network hiccup: keep polling.
			}
			if (signal.aborted) return;

			if (typeof result.access_token === 'string') {
				const user = await api('/user', result.access_token);
				const profile = (user.data ?? {}) as { login?: string; avatar_url?: string };
				const login: StoredLogin = {
					token: result.access_token,
					login: profile.login ?? 'unknown',
					avatarUrl: profile.avatar_url ?? null,
					expiresAt:
						typeof result.expires_in === 'number'
							? new Date(Date.now() + result.expires_in * 1000).toISOString()
							: null
				};
				await opts.secrets.set(OAUTH_SECRET, JSON.stringify(login));
				opts.events.emit({ type: 'github.login', status: 'signed_in' });
				return;
			}
			switch (result.error) {
				case 'authorization_pending':
					break;
				case 'slow_down':
					wait = (typeof result.interval === 'number' ? result.interval * 1000 : wait) + 5000;
					break;
				case 'access_denied':
					opts.events.emit({ type: 'github.login', status: 'denied' });
					return;
				case 'expired_token':
					opts.events.emit({ type: 'github.login', status: 'expired' });
					return;
				default:
					opts.events.emit({
						type: 'github.login',
						status: 'failed',
						message: String(result.error_description ?? result.error ?? 'Unknown error')
					});
					return;
			}
		}
		if (!signal.aborted) opts.events.emit({ type: 'github.login', status: 'expired' });
	}

	return {
		async start(): Promise<GitHubLoginStart> {
			const clientId = await opts.getClientId();
			if (!clientId) {
				throw new EngineError(
					'github_login_unavailable',
					'Set the GitHub App client ID in Settings (or PATCHWORK_GITHUB_CLIENT_ID) to sign in with GitHub.'
				);
			}
			let res: Record<string, unknown>;
			try {
				res = await postForm(`${opts.webUrl}/login/device/code`, { client_id: clientId });
			} catch (error) {
				throw new EngineError(
					'github_failed',
					`Could not reach GitHub: ${(error as Error).message}`
				);
			}
			if (typeof res.device_code !== 'string' || typeof res.user_code !== 'string') {
				const reason = String(res.error_description ?? res.error ?? 'unexpected response');
				const hint =
					res.error === 'device_flow_disabled'
						? 'Turn on "Enable Device Flow" in the GitHub App\'s settings on GitHub (General → Identifying and authorizing users), then try again.'
						: res.error === 'unauthorized_client' || res.error === 'incorrect_client_credentials'
							? 'Check that the client ID belongs to your GitHub App.'
							: 'Check the client ID and that "Enable Device Flow" is on in the GitHub App.';
				throw new EngineError(
					'github_failed',
					`GitHub didn't start the sign-in (${reason}). ${hint}`
				);
			}
			pending?.abort();
			pending = new AbortController();
			const expiresAt = Date.now() + Number(res.expires_in ?? 900) * 1000;
			const intervalMs = Math.max(Number(res.interval ?? 5) * 1000, 100);
			const controller = pending;
			void poll(clientId, res.device_code, intervalMs, expiresAt, controller.signal).finally(() => {
				if (pending === controller) pending = null;
			});
			return {
				userCode: res.user_code,
				verificationUri: String(res.verification_uri ?? `${opts.webUrl}/login/device`),
				expiresAt: new Date(expiresAt).toISOString()
			};
		},

		/** Whether a sign-in is waiting for the user to approve it on GitHub. */
		pending() {
			return pending !== null && !pending.signal.aborted;
		},

		cancel() {
			const had = pending !== null && !pending.signal.aborted;
			pending?.abort();
			pending = null;
			return had;
		},

		async signOut() {
			await opts.secrets.set(OAUTH_SECRET, null);
			opts.events.emit({ type: 'github.login', status: 'signed_out' });
		},

		async account(): Promise<GitHubAccount | null> {
			const login = await stored();
			return login && (await this.token())
				? { login: login.login, avatarUrl: login.avatarUrl }
				: null;
		},

		/** The signed-in user's token; null (and signed out) once it has expired. */
		async token(): Promise<string | null> {
			const login = await stored();
			if (!login) return null;
			if (login.expiresAt && Date.parse(login.expiresAt) <= Date.now()) {
				await opts.secrets.set(OAUTH_SECRET, null);
				opts.events.emit({
					type: 'github.login',
					status: 'expired',
					message: 'Your GitHub sign-in expired. Sign in again.'
				});
				return null;
			}
			return login.token;
		},

		async listRepositories(): Promise<GitHubRepository[]> {
			const token = await this.token();
			if (!token) throw new EngineError('github_not_signed_in', 'Sign in with GitHub first.');
			const res = await api('/user/repos?per_page=100&sort=updated', token);
			if (res.status === 401) {
				await this.signOut();
				throw new EngineError(
					'github_not_signed_in',
					'Your GitHub sign-in is no longer valid. Sign in again.'
				);
			}
			if (res.status !== 200 || !Array.isArray(res.data)) {
				throw new EngineError(
					'github_failed',
					`GitHub couldn't list repositories (${res.status}).`
				);
			}
			return (
				res.data as {
					full_name: string;
					clone_url: string;
					private: boolean;
					description: string | null;
					updated_at: string | null;
				}[]
			).map((r) => ({
				fullName: r.full_name,
				cloneUrl: r.clone_url,
				private: r.private,
				description: r.description,
				updatedAt: r.updated_at
			}));
		}
	};
}
