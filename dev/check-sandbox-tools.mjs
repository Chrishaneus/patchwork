// After `npm install`: on Linux, say how to install what the agent's sandbox needs (bubblewrap
// and socat), if they're missing. It only prints; it never installs anything or fails the
// install. The app says the same in Settings and when the server starts.
//
// Standalone because it runs before anything is built; `installCommand` in
// engine/agent/sandbox.ts is the engine's version of the same lookup.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const quiet =
	process.platform !== 'linux' ||
	process.env.CI ||
	process.env.PATCHWORK_SKIP_SANDBOX_CHECK ||
	// Docker builds: the image installs them in its own last stage.
	existsSync('/.dockerenv');

const onPath = (name) =>
	(process.env.PATH ?? '').split(path.delimiter).some((dir) => {
		try {
			accessSync(path.join(dir, name), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});

function installCommand(packages) {
	let release = '';
	try {
		release = readFileSync('/etc/os-release', 'utf8');
	} catch {
		// Unknown distribution: just name the packages.
	}
	const ids = [...release.matchAll(/^(ID|ID_LIKE)=["']?([^"'\n]*)/gm)]
		.map((m) => m[2])
		.join(' ')
		.toLowerCase();
	const managers = [
		[/\b(debian|ubuntu)\b/, 'sudo apt install'],
		[/\b(fedora|rhel|centos)\b/, 'sudo dnf install'],
		[/\barch\b/, 'sudo pacman -S'],
		[/\b(suse|opensuse)\b/, 'sudo zypper install'],
		[/\balpine\b/, 'sudo apk add']
	];
	const manager = managers.find(([pattern]) => pattern.test(ids))?.[1];
	return manager ? `${manager} ${packages.join(' ')}` : null;
}

try {
	if (!quiet) {
		const missing = [
			['bwrap', 'bubblewrap'],
			['socat', 'socat']
		]
			.filter(([command]) => !onPath(command))
			.map(([, pkg]) => pkg);
		if (missing.length > 0) {
			const command = installCommand(missing);
			console.warn(
				[
					'',
					`Patchwork: the agent's sandbox needs ${missing.join(' and ')}, which ${missing.length > 1 ? 'aren’t' : 'isn’t'} installed.`,
					command
						? `  Install with: ${command}`
						: `  Install ${missing.join(' and ')} with your package manager.`,
					`  Without ${missing.length > 1 ? 'them' : 'it'}, shell commands the agent runs aren’t sandboxed.`,
					''
				].join('\n')
			);
		}
	}
} catch {
	// Never fail an install over a hint.
}
