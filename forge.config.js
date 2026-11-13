/**
 * The platform and architecture being built: `--platform`/`--arch` when building for another
 * system (e.g. Windows from Linux), else this machine's.
 */
function target(flag, fallback) {
	const args = process.argv;
	const i = args.findIndex((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
	if (i === -1) return fallback;
	return args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
}
const platform = target('platform', process.platform);
const arch = target('arch', process.arch);

/** Paths (relative to the app root) that go into the packaged app. */
const keep = [
	'/package.json',
	'/dist-electron',
	'/build',
	// The AI agent: the SDK, its runtime dependency, and the native Claude Code binary.
	'/node_modules/@anthropic-ai/claude-agent-sdk',
	// The agent binary for the system being built for (claude.exe on Windows).
	`/node_modules/@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
	'/node_modules/zod',
	// Codex, for OpenAI models: the CLI package and the native binary its app-server runs from.
	'/node_modules/@openai/codex',
	`/node_modules/@openai/codex-${platform}-${arch}`,
	// Gemini CLI, for Google models (one self-contained bundle), and srt, the sandbox it runs in,
	// with srt's dependencies (its own copies of zod and commander sit inside its folder).
	'/node_modules/@google/gemini-cli',
	'/node_modules/@anthropic-ai/sandbox-runtime',
	'/node_modules/node-forge',
	'/node_modules/@pondwader/socks5-server'
];

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
const config = {
	packagerConfig: {
		name: 'Patchwork',
		executableName: 'patchwork',
		// Executables can't be started from inside the asar archive, so the agent binaries are
		// unpacked; so are srt (it starts helper binaries from its own folder) with its
		// dependencies, and Gemini CLI, which srt runs.
		asar: {
			unpack:
				'{**/node_modules/@anthropic-ai/claude-agent-sdk-*/**,**/node_modules/@openai/codex-*-*/**,**/node_modules/@anthropic-ai/sandbox-runtime/**,**/node_modules/node-forge/**,**/node_modules/@pondwader/socks5-server/**,**/node_modules/@google/gemini-cli/**}'
		},
		ignore: (file) =>
			!!file &&
			// Gemini CLI's optional native modules (node-pty, for an interactive shell it doesn't
			// use here) would have to be rebuilt for Electron.
			(file.startsWith('/node_modules/@google/gemini-cli/node_modules') ||
				!keep.some(
					(path) =>
						file === path ||
						file.startsWith(`${path}/`) ||
						// Keep parent folders of kept paths, e.g. /node_modules and /node_modules/@anthropic-ai.
						path.startsWith(`${file}/`)
				))
	},
	makers: [
		{ name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: {} },
		{ name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'], config: {} },
		{
			name: '@electron-forge/maker-deb',
			platforms: ['linux'],
			config: {
				// The agent's shell commands are sandboxed with bubblewrap, and socat carries their
				// network traffic to the proxy that filters it. Added to the default dependencies.
				options: { depends: ['bubblewrap', 'socat'] }
			}
		}
	]
};

export default config;
