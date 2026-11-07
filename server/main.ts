// The Patchwork server: the web UI plus the engine API, for Docker, local mode and (later) the
// mobile apps.
//
// Local mode (PATCHWORK_LOCAL=1, `npm run server:local`) runs the engine directly on your machine,
// like the desktop app: local folders in your home folder (or PATCHWORK_REPOS) can be used, it
// listens on localhost only, and the agent can use your Claude login.
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { applyLegacyEnv, migrateDataDir } from '../engine/core/env.js';
import {
	classifyByRules,
	createEngine,
	createTestAgent,
	FileSecretStore
} from '../engine/index.js';
import { createRequestHandler } from './app.js';

applyLegacyEnv();
const env = process.env;
const list = (value: string | undefined) =>
	(value ?? '')
		.split(/[,:]/)
		.map((s) => s.trim())
		.filter(Boolean);

const local = env.PATCHWORK_LOCAL === '1';
const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? (local ? '127.0.0.1' : '0.0.0.0');
const dataDir = path.resolve(
	env.PATCHWORK_DATA_DIR ?? (local ? path.join(homedir(), '.patchwork', 'server') : '.data')
);
// Local mode kept its data in ~/.ai-tool before the app was renamed to Patchwork.
if (local && !env.PATCHWORK_DATA_DIR) {
	migrateDataDir(path.join(homedir(), '.ai-tool', 'server'), dataDir);
}
const mountedRoots = list(env.PATCHWORK_REPOS);
const repositoryRoots = mountedRoots.length > 0 ? mountedRoots : local ? [homedir()] : [];
const staticDir = path.resolve(
	env.PATCHWORK_STATIC_DIR ?? path.join(import.meta.dirname, '..', 'build')
);

const engine = createEngine({
	dataDir,
	repositoryRoots,
	// Local folders only in local mode or when folders were mounted for the server.
	localPaths: repositoryRoots.length > 0,
	githubClientId: env.PATCHWORK_GITHUB_CLIENT_ID || undefined,
	githubWebUrl: env.PATCHWORK_GITHUB_WEB_URL || undefined,
	githubApiUrl: env.PATCHWORK_GITHUB_API_URL || undefined,
	gitlabApiUrl: env.PATCHWORK_GITLAB_API_URL || undefined,
	secrets: new FileSecretStore(path.join(dataDir, 'secrets.json')),
	// End-to-end tests use a scripted agent instead of the real model.
	runAgent: env.PATCHWORK_TEST_AGENT ? createTestAgent(env.PATCHWORK_TEST_AGENT) : undefined,
	classifyMode: env.PATCHWORK_TEST_AGENT ? classifyByRules : undefined
});

const server = createServer(
	createRequestHandler({
		engine,
		staticDir,
		token: env.PATCHWORK_TOKEN || undefined,
		allowedHosts: list(env.PATCHWORK_ALLOWED_HOSTS)
	})
);

server.listen(port, host, () => {
	console.log(`Patchwork server on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
	console.log(`  data:         ${dataDir}`);
	console.log(
		`  local folders: ${repositoryRoots.length ? repositoryRoots.join(', ') : 'off (repositories are added by URL)'}`
	);
	console.log(`  access token: ${env.PATCHWORK_TOKEN ? 'required' : 'off (localhost only)'}`);
	if (local)
		console.log(
			'  local mode:   on (local folders allowed; open the address above in your browser)'
		);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close();
		server.closeAllConnections();
		process.exit(0);
	});
}
