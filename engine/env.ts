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
