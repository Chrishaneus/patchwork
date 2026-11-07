import path from 'node:path';

export type ToolDecision = { allow: true } | { allow: false; reason: string };

const FILE_TOOLS: Record<string, string> = {
	Edit: 'file_path',
	MultiEdit: 'file_path',
	Write: 'file_path',
	NotebookEdit: 'notebook_path'
};

/** Shell commands the agent may not run: publishing is the app's job, after you review. */
const BLOCKED_COMMANDS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\bgit\s+push\b/, reason: 'Pushing is done by the app after review.' },
	{
		pattern: /\bgit\s+remote\s+(add|set-url|remove|rm|rename)\b/,
		reason: 'Changing remotes is not allowed.'
	},
	{ pattern: /\bgit\s+worktree\b/, reason: 'The worktree is managed by the app.' },
	{
		pattern: /\bgh\s+(pr|release|repo|api)\b/,
		reason: 'Pull requests are opened by the app after review.'
	}
];

const inside = (cwd: string, target: string) => {
	const resolved = path.resolve(cwd, target);
	return resolved === cwd || resolved.startsWith(cwd + path.sep);
};

/**
 * Decide whether the agent may use a tool. The worktree is the agent's sandbox: file changes must
 * stay inside it, and anything that publishes work is reserved for the app.
 */
export function decideToolUse(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	/** Review and explore workflows: reading, searching and running commands only. */
	readOnly = false
): ToolDecision {
	const fileKey = FILE_TOOLS[tool];
	if (fileKey && readOnly) {
		return { allow: false, reason: 'This is a read-only workflow: files may not be changed.' };
	}
	if (fileKey) {
		const target = input[fileKey];
		if (typeof target !== 'string' || !inside(cwd, target)) {
			return { allow: false, reason: `Only files inside ${cwd} may be changed.` };
		}
		return { allow: true };
	}

	if (tool === 'Bash') {
		const command = typeof input.command === 'string' ? input.command : '';
		const blocked = BLOCKED_COMMANDS.find(({ pattern }) => pattern.test(command));
		return blocked ? { allow: false, reason: blocked.reason } : { allow: true };
	}

	return { allow: true };
}
