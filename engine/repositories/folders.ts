import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { EngineError, type FolderEntry, type FolderListing } from '#lib/engine/contract.js';

const MAX_ENTRIES = 500;
/** Folders that are never worth browsing into. */
const SKIP = new Set(['node_modules', '__pycache__', '.git']);

export const isInside = (root: string, target: string) =>
	target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The real location of a folder (symlinks resolved), or null when it doesn't exist. */
export async function realFolder(target: string): Promise<string | null> {
	try {
		const real = await realpath(target);
		return (await stat(real)).isDirectory() ? real : null;
	} catch {
		return null;
	}
}

/**
 * Resolve `target` and check it lies inside one of `roots` after following symlinks, so a link
 * inside an allowed folder can't lead outside it. With no roots, anywhere is allowed.
 */
export async function resolveAllowed(target: string, roots: string[]): Promise<string> {
	const real = await realFolder(path.resolve(target));
	if (!real) throw new EngineError('folder_not_found', `Folder not found: ${target}`);
	if (roots.length === 0) return real;
	const realRoots = (await Promise.all(roots.map(realFolder))).filter((r): r is string => !!r);
	if (!realRoots.some((root) => isInside(root, real))) {
		throw new EngineError(
			'outside_repository_roots',
			`Folders must be inside ${roots.join(' or ')}.`
		);
	}
	return real;
}

const hasGit = async (dir: string) => !!(await stat(path.join(dir, '.git')).catch(() => null));

/**
 * The folder browser behind "Browse…" in the web app: one level at a time, folders only, hidden
 * folders and dependency folders left out, git repositories marked.
 */
export async function browseFolders(
	target: string | undefined,
	roots: string[]
): Promise<FolderListing> {
	const realRoots = (await Promise.all(roots.map(realFolder))).filter((r): r is string => !!r);

	// No folder given: start at the only root, list the roots, or (desktop) start at home.
	if (!target) {
		if (realRoots.length > 1) {
			const entries = await Promise.all(
				realRoots.map(async (root) => ({
					name: root,
					path: root,
					isGitRepository: await hasGit(root)
				}))
			);
			return { path: null, isGitRepository: false, entries, truncated: false };
		}
		target = realRoots[0] ?? homedir();
	}

	const dir = await resolveAllowed(target, roots);
	let names: string[];
	try {
		names = (await readdir(dir, { withFileTypes: true }))
			.filter(
				(e) =>
					(e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !SKIP.has(e.name)
			)
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		throw new EngineError('folder_not_found', `Can't read folder: ${dir}`);
	}

	const entries: FolderEntry[] = [];
	for (const name of names.slice(0, MAX_ENTRIES)) {
		const full = path.join(dir, name);
		// Skip links that lead outside the allowed folders or to files.
		const real = await realFolder(full);
		if (!real || (realRoots.length > 0 && !realRoots.some((root) => isInside(root, real))))
			continue;
		entries.push({ name, path: full, isGitRepository: await hasGit(full) });
	}

	const atRoot = realRoots.includes(dir);
	const parentDir = path.dirname(dir);
	const parent =
		realRoots.length === 0
			? parentDir === dir
				? undefined
				: parentDir
			: atRoot
				? realRoots.length > 1
					? null
					: undefined
				: parentDir;

	return {
		path: dir,
		parent,
		isGitRepository: await hasGit(dir),
		entries,
		truncated: names.length > MAX_ENTRIES
	};
}
