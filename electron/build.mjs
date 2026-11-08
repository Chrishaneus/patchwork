// Bundles the Electron main and preload scripts (plus the engine) into dist-electron/.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	sourcemap: true,
	// The Claude SDK starts its native binary from its own package folder, so it can't be bundled.
	external: ['electron', '@anthropic-ai/claude-agent-sdk'],
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
