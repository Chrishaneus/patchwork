// Build the Windows app from any system: `npm run electron:make:win` (x64; pass `--arch arm64`
// for ARM). The output is a zip in out/make/zip/win32/ — unzip it and run Patchwork.exe.
//
// Electron itself is downloaded for Windows by Electron Forge. The Windows-only pieces this
// script adds are the agents' binaries, claude.exe and codex.exe, fetched from npm at the SDKs'
// versions without touching package.json. The Squirrel installer (Setup.exe) is only built on Windows: from Linux or macOS
// it needs Wine and Mono.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arch = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : 'x64';
const root = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, cmdArgs, opts = {}) =>
	execFileSync(cmd, cmdArgs, {
		cwd: root,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		...opts
	});

const versionOf = (pkg) =>
	JSON.parse(readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;

/** Unpack the npm package `spec` into node_modules/`folder`, unless that version is there. */
function fetchPackage(folder, spec, version, what) {
	const dest = path.join(root, 'node_modules', folder);
	if (existsSync(path.join(dest, 'package.json')) && versionOf(folder) === version) return;
	console.log(`Fetching ${spec} (${what})…`);
	const tmp = mkdtempSync(path.join(tmpdir(), 'patchwork-win-'));
	try {
		const file = execFileSync(npm, ['pack', spec, '--pack-destination', tmp], {
			cwd: tmp,
			encoding: 'utf8',
			shell: process.platform === 'win32'
		})
			.trim()
			.split('\n')
			.pop();
		rmSync(dest, { recursive: true, force: true });
		mkdirSync(dest, { recursive: true });
		execFileSync('tar', ['-xzf', path.join(tmp, file), '-C', dest, '--strip-components=1']);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const claude = `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
const claudeVersion = versionOf('@anthropic-ai/claude-agent-sdk');
fetchPackage(claude, `${claude}@${claudeVersion}`, claudeVersion, "the agent's claude.exe");
// Codex publishes its platform binaries as versions of @openai/codex (e.g. 0.167.0-win32-x64).
const codexVersion = `${versionOf('@openai/codex')}-win32-${arch}`;
fetchPackage(
	`@openai/codex-win32-${arch}`,
	`@openai/codex@${codexVersion}`,
	codexVersion,
	"Codex's codex.exe"
);

run(npm, ['run', 'build']);
run(npm, ['run', 'electron:compile']);
run(npx, [
	'electron-forge',
	'make',
	'--platform=win32',
	`--arch=${arch}`,
	...(process.platform === 'win32' ? [] : ['--targets=@electron-forge/maker-zip'])
]);
