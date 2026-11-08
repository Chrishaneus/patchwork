/**
 * Programs that run whatever they're given, so allowing one "always" would allow anything:
 * shells, interpreters and commands that run other commands.
 */
const RUNS_ANYTHING = new Set([
	'sh',
	'bash',
	'zsh',
	'fish',
	'dash',
	'ksh',
	'cmd',
	'powershell',
	'pwsh',
	'node',
	'deno',
	'bun',
	'python',
	'python3',
	'py',
	'ruby',
	'perl',
	'php',
	'npx',
	'bunx',
	'env',
	'sudo',
	'doas',
	'xargs',
	'eval',
	'exec',
	'nohup',
	'time',
	'timeout',
	'nice',
	'watch',
	'ssh'
]);

/** Chaining, pipes, redirects and substitutions: the command runs more than one program. */
const COMPOUND = /&&|\|\||[;|&<>`\n]|\$\(/;

/**
 * The program a command runs (`docker` for `FOO=1 /usr/bin/docker compose up`), for "Always
 * allow" to match on. Null when that wouldn't be safe: a compound command, or a program that
 * runs whatever it's given.
 */
export function programOf(command: string): string | null {
	const text = command.trim();
	if (!text || COMPOUND.test(text)) return null;
	// Leading variable assignments (`FOO=1 cmd`) set the environment, they aren't the program;
	// a quoted program path may contain spaces.
	const match = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text);
	const first = match && (match[1] ?? match[2] ?? match[3]);
	if (!first || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
	const name = first
		.split(/[\\/]/)
		.pop()!
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
	if (!/^[a-z0-9][a-z0-9._+-]*$/.test(name) || RUNS_ANYTHING.has(name)) return null;
	return name;
}
