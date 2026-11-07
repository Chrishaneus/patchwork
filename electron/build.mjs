// Bundles the Electron main and preload scripts (plus the engine) into dist-electron/.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	sourcemap: true,
	// The agent SDKs start native binaries from their own package folders, so they can't be bundled.
	external: ['electron', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
	logLevel: 'info'
};

const entries = [
	{ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
	{ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }
];

if (watch) {
	const { context } = await import('esbuild');
	for (const entry of entries) await (await context({ ...common, ...entry })).watch();
} else {
	await Promise.all(entries.map((entry) => build({ ...common, ...entry })));
}
