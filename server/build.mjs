// Bundles the server (plus the engine) into dist-server/server.mjs.
import { build } from 'esbuild';

await build({
	entryPoints: ['server/main.ts'],
	outfile: 'dist-server/server.mjs',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: true,
	// The agent SDK starts a native binary from its own package folder, so it can't be bundled.
	external: ['@anthropic-ai/claude-agent-sdk'],
	logLevel: 'info'
});
