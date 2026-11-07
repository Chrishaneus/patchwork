// Build the Windows app from any system: `npm run electron:make:win` (x64; pass `--arch arm64`
// for ARM). The output is a zip in out/make/zip/win32/ — unzip it and run Patchwork.exe.
//
// Electron itself is downloaded for Windows by Electron Forge. The one Windows-only piece this
// script adds is the agent's claude.exe, fetched from npm at the SDK's version without touching
// package.json. The Squirrel installer (Setup.exe) is only built on Windows: from Linux or macOS
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

const sdk = JSON.parse(
	readFileSync(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')
);
const name = `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
const dest = path.join(root, 'node_modules', name);
const installed = existsSync(path.join(dest, 'package.json'))
	? JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).version
	: null;

if (installed !== sdk.version) {
	console.log(`Fetching ${name}@${sdk.version} (the agent's claude.exe)…`);
	const tmp = mkdtempSync(path.join(tmpdir(), 'patchwork-win-'));
	try {
		const file = execFileSync(npm, ['pack', `${name}@${sdk.version}`, '--pack-destination', tmp], {
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

run(npm, ['run', 'build']);
run(npm, ['run', 'electron:compile']);
run(npx, [
	'electron-forge',
	'make',
	'--platform=win32',
	`--arch=${arch}`,
	...(process.platform === 'win32' ? [] : ['--targets=@electron-forge/maker-zip'])
]);
