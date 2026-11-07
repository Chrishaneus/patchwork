import { defineConfig } from '@playwright/test';

// `npm run test:e2e` builds the UI and the server first; these commands only start them.
const server = (port: number, env: string) =>
	`rm -rf .e2e/data-${port} && mkdir -p .e2e/repos && ${env} PATCHWORK_DATA_DIR=.e2e/data-${port} PORT=${port} HOST=127.0.0.1 node dist-server/server.mjs`;

export default defineConfig({
	testMatch: '**/*.e2e.{ts,js}',
	testIgnore: ['electron/**'],
	// Runs after the servers below have started.
	globalSetup: './dev/e2e-setup.ts',
	webServer: [
		// A fake GitHub (sign-in, repositories, pull requests) plus the e2e git fixtures.
		{ command: 'node dev/e2e-github.ts --port 4011', port: 4011, reuseExistingServer: false },
		// The full app: UI + engine API, with a scripted agent instead of the real model.
		{
			command: server(
				4173,
				[
					'PATCHWORK_TEST_AGENT=edit',
					'PATCHWORK_REPOS=.e2e/repos',
					'PATCHWORK_GITHUB_API_URL=http://127.0.0.1:4011',
					'PATCHWORK_GITHUB_WEB_URL=http://127.0.0.1:4011',
					'PATCHWORK_GITHUB_CLIENT_ID=Iv23liE2eClient',
					'GITHUB_TOKEN=e2e-token',
					`GIT_CONFIG_GLOBAL=${process.cwd()}/.e2e/gitconfig`
				].join(' ')
			),
			port: 4173,
			reuseExistingServer: false
		},
		// The same, protected by an access token.
		{
			command: server(4175, 'PATCHWORK_TOKEN=e2e-token PATCHWORK_REPOS=.e2e/repos'),
			port: 4175,
			reuseExistingServer: false
		},
		// A server without mounted folders: repositories can only be added by URL.
		{ command: server(4176, ''), port: 4176, reuseExistingServer: false },
		// Only the static files, no engine (like the plain web build).
		{ command: 'npx vite preview --port 4174 --strictPort', port: 4174, reuseExistingServer: false }
	],
	use: { baseURL: 'http://localhost:4173' }
});
