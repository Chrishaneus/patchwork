import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * The app was called "AI Tool" before it became Patchwork. Settings were named AI_TOOL_*; they
 * still work: each one is copied to its PATCHWORK_* name unless that is set too.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env) {
	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith('AI_TOOL_') || value === undefined) continue;
		const modern = `PATCHWORK_${name.slice('AI_TOOL_'.length)}`;
		if (env[modern] === undefined) env[modern] = value;
	}
}

/**
 * Credentials the app reads from its environment, plus the ones the `gh` and `glab` CLIs pick up.
 * What runs in a repository (the agent, check commands) never sees them: with a token it could
 * call the GitHub or GitLab API directly, around the "no push, no pull requests" rules.
 */
export const SECRET_ENV = [
	'ANTHROPIC_API_KEY',
	'GITHUB_TOKEN',
	'GH_TOKEN',
	'GH_ENTERPRISE_TOKEN',
	'GITHUB_ENTERPRISE_TOKEN',
	'GITLAB_TOKEN',
	'GITLAB_ACCESS_TOKEN',
	'PATCHWORK_TOKEN',
	'AI_TOOL_TOKEN'
];

/** This process's environment without `SECRET_ENV`, then `extra` on top. */
export function withoutSecrets(
	extra: Record<string, string | undefined> = {},
	env: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
	const result: Record<string, string | undefined> = { ...env };
	for (const name of SECRET_ENV) delete result[name];
	return { ...result, ...extra };
}

/**
 * Move data from its old location (from when the app was "AI Tool") to the new one, once: only
 * when the old folder exists and the new one doesn't. Returns whether anything moved.
 */
export function migrateDataDir(from: string, to: string): boolean {
	if (!existsSync(from) || existsSync(to)) return false;
	mkdirSync(path.dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch {
		// Different filesystems: copy, then remove the old folder.
		cpSync(from, to, { recursive: true });
		rmSync(from, { recursive: true, force: true });
	}
	return true;
}
