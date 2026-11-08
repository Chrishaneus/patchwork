import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
/** What inspecting a folder (or a URL) tells us about a repository. */
type RepositoryDetails = Omit<
	Repository,
	'id' | 'addedAt' | 'checkCommand' | 'managed' | 'cloneStatus' | 'cloneError'
>;

import {
	EngineError,
	type CloneStatus,
	type Repository,
	type RepositoryCandidates,
	type RepositoryStatus,
	type RepositoryWithStatus
} from '#lib/engine/contract.js';
import { git, parseRemoteUrl, tryGit } from '../git/git.js';
import { browseFolders, resolveAllowed } from './folders.js';
import { programOf } from '../agent/approvals.js';
import type { JsonStore } from '../core/store.js';

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Inspect a folder and describe it as a repository, or throw an EngineError explaining why not. */
export async function inspectRepository(inputPath: string): Promise<RepositoryDetails> {
	const dir = path.resolve(inputPath.trim());
	if (!(await isDirectory(dir))) {
		throw new EngineError('path_not_found', `Folder not found: ${dir}`);
	}

	const root = await tryGit(dir, ['rev-parse', '--show-toplevel']);
	if (!root) {
		throw new EngineError('not_a_git_repository', `Not a git repository: ${dir}`);
	}

	const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
	const remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
	if (!remoteName) {
		throw new EngineError('no_remote', `The repository has no remote to push to: ${root}`);
	}

	// The URL as configured; `git remote get-url` would apply url.*.insteadOf rewrites and hide
	// that the remote is, say, GitHub.
	const remoteUrl =
		(await tryGit(root, ['config', '--get', `remote.${remoteName}.url`])) ??
		(await git(root, ['remote', 'get-url', remoteName]));
	const { provider, slug } = parseRemoteUrl(remoteUrl);

	return {
		name: slug?.split('/').pop() ?? path.basename(root),
		path: root,
		remoteName,
		remoteUrl,
		provider,
		slug,
		defaultBranch: await findDefaultBranch(root, remoteName)
	};
}

async function findDefaultBranch(root: string, remoteName: string): Promise<string> {
	const remoteHead = await tryGit(root, [
		'symbolic-ref',
		'--short',
		`refs/remotes/${remoteName}/HEAD`
	]);
	if (remoteHead) return remoteHead.slice(remoteName.length + 1);

	for (const candidate of ['main', 'master']) {
		if (
			await tryGit(root, [
				'rev-parse',
				'--verify',
				'--quiet',
				`refs/remotes/${remoteName}/${candidate}`
			])
		) {
			return candidate;
		}
	}
	return (await tryGit(root, ['symbolic-ref', '--short', 'HEAD'])) ?? 'main';
}

export async function readStatus(repoPath: string): Promise<RepositoryStatus> {
	const checkedAt = new Date().toISOString();
	const root = (await isDirectory(repoPath))
		? await tryGit(repoPath, ['rev-parse', '--show-toplevel'])
		: null;
	if (!root) {
		return { available: false, currentBranch: null, uncommittedChanges: 0, checkedAt };
	}

	const [branch, porcelain] = await Promise.all([
		tryGit(root, ['symbolic-ref', '--short', 'HEAD']),
		tryGit(root, ['status', '--porcelain'])
	]);
	return {
		available: true,
		currentBranch: branch,
		uncommittedChanges: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
		checkedAt
	};
}

const withStatus = async (repo: Repository): Promise<RepositoryWithStatus> => ({
	...repo,
	// Repositories saved before checks existed have no checkCommand.
	checkCommand: repo.checkCommand ?? null,
	managed: repo.managed ?? false,
	// Repositories added before clone-on-demand were always cloned right away.
	cloneStatus: repo.cloneStatus ?? (repo.managed ? 'ready' : null),
	cloneError: repo.cloneError ?? null,
	status: await readStatus(repo.path)
});

const isInside = (root: string, target: string) =>
	target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Find git repositories up to two levels below each root, skipping hidden and dependency folders. */
async function findGitRepositories(roots: string[]): Promise<string[]> {
	const found: string[] = [];
	async function walk(dir: string, depth: number) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.name === '.git')) {
			found.push(dir);
			return;
		}
		if (depth === 0) return;
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
				continue;
			await walk(path.join(dir, entry.name), depth - 1);
		}
	}
	for (const root of roots) await walk(root, 2);
	return found;
}

/**
 * @param roots When set (server mode), repositories must live inside one of these folders, and
 *   `candidates()` lists the ones found there.
 */
export interface RepositoryServiceOptions {
	/** Server mode: folders local repositories must live in (e.g. the mounted /repos). */
	roots?: string[];
	/** Whether local folders may be added at all (desktop: yes; server: only with roots). */
	localPaths?: boolean;
	/** Where repositories added by URL are cloned. */
	clonesDir: string;
	/** git credentials for a remote URL (HTTPS tokens), so private repositories can be cloned. */
	authEnvFor: (remoteUrl: string) => Promise<Record<string, string>>;
	/** Called when a repository changes on its own (cloning while preparing a run). */
	onUpdate?: (repository: RepositoryWithStatus) => void;
}

/** Check a clone URL. Local paths and file:// URLs only where local folders are allowed. */
export function validateCloneUrl(url: string, localPaths: boolean): string {
	const value = url?.trim() ?? '';
	if (!value || /\s/.test(value) || value.startsWith('-')) {
		throw new EngineError(
			'invalid_url',
			'Enter a repository URL, like https://github.com/owner/name.'
		);
	}
	const isRemote =
		/^(https?|ssh|git):\/\//i.test(value) || /^[^@/\s]+@[^:/\s]+:[^\s]+$/.test(value);
	const isLocal = value.startsWith('file://') || path.isAbsolute(value);
	if (!isRemote && !(localPaths && isLocal)) {
		throw new EngineError(
			'invalid_url',
			localPaths
				? 'Enter an https://, ssh:// or git@host:owner/name URL.'
				: 'Enter an https://, ssh:// or git@host:owner/name URL. Local folders are turned off on this server.'
		);
	}
	return value;
}

export function createRepositoryService(store: JsonStore, options: RepositoryServiceOptions) {
	const roots = options.roots ?? [];
	const resolvedRoots = roots.map((r) => path.resolve(r));
	const localPaths = options.localPaths ?? true;
	const clonesDir = path.resolve(options.clonesDir);

	async function save(
		details: RepositoryDetails,
		managed: boolean,
		clone: { status: CloneStatus | null; error?: string | null } = {
			status: managed ? 'ready' : null
		}
	) {
		const repo = await store.update((data) => {
			if (data.repositories.some((r) => r.path === details.path)) {
				throw new EngineError('already_added', `Already added: ${details.path}`);
			}
			const created: Repository = {
				id: randomUUID(),
				addedAt: new Date().toISOString(),
				...details,
				checkCommand: null,
				managed,
				cloneStatus: clone.status,
				cloneError: clone.error ?? null
			};
			data.repositories.push(created);
			return created;
		});
		return withStatus(repo);
	}

	const cloning = new Map<string, Promise<RepositoryWithStatus>>();

	/** Ask the remote for its default branch without cloning (also checks it's reachable). */
	async function remoteDefaultBranch(url: string): Promise<string> {
		await mkdir(clonesDir, { recursive: true });
		let output: string;
		try {
			output = await git(clonesDir, ['ls-remote', '--symref', '--', url, 'HEAD'], {
				timeoutMs: 60_000,
				env: await options.authEnvFor(url)
			});
		} catch (error) {
			// Only git's own output: the error message would include the command line.
			const stderr = (error as { stderr?: string }).stderr?.trim();
			throw new EngineError(
				'clone_failed',
				`Could not reach ${url}: ${stderr || 'git ls-remote failed'}`
			);
		}
		return /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(output)?.[1] ?? 'main';
	}

	async function setClone(id: string, status: CloneStatus, error: string | null = null) {
		const repo = await store.update((data) => {
			const index = data.repositories.findIndex((r) => r.id === id);
			data.repositories[index] = {
				...data.repositories[index],
				cloneStatus: status,
				cloneError: error
			};
			return data.repositories[index];
		});
		const withState = await withStatus(repo);
		options.onUpdate?.(withState);
		return withState;
	}

	async function doClone(id: string): Promise<RepositoryWithStatus> {
		const repo = await find(id);
		if (!repo.managed)
			throw new EngineError('invalid_state', 'Only repositories added by URL are cloned.');
		if ((repo.cloneStatus ?? 'ready') === 'ready' && (await stat(repo.path).catch(() => null))) {
			return withStatus(repo);
		}
		const target = path.resolve(repo.path);
		if (!isInside(clonesDir, target) || target === clonesDir) {
			throw new EngineError(
				'invalid_state',
				`Refusing to clone outside the app's data folder: ${target}`
			);
		}
		await setClone(id, 'cloning');
		await rm(target, { recursive: true, force: true });
		await mkdir(path.dirname(target), { recursive: true });
		try {
			await git(clonesDir, ['clone', '--quiet', '--', repo.remoteUrl, target], {
				timeoutMs: 10 * 60_000,
				env: await options.authEnvFor(repo.remoteUrl)
			});
		} catch (error) {
			await rm(target, { recursive: true, force: true });
			const stderr = (error as { stderr?: string }).stderr?.trim();
			const message = `Could not clone ${repo.remoteUrl}: ${stderr || 'git clone failed'}`;
			await setClone(id, 'failed', message);
			throw new EngineError('clone_failed', message);
		}
		// The clone knows the real default branch and remote name.
		const details = await inspectRepository(target).catch(() => null);
		if (details) {
			await store.update((data) => {
				const index = data.repositories.findIndex((r) => r.id === id);
				data.repositories[index] = {
					...data.repositories[index],
					defaultBranch: details.defaultBranch,
					remoteName: details.remoteName
				};
			});
		}
		return setClone(id, 'ready');
	}

	/** A fresh folder for a clone, named after the repository: clones/<host>/<owner>/<name>. */
	async function cloneTarget(url: string, reserved: string[] = []) {
		const { host, slug } = parseRemoteUrl(url);
		const name =
			(slug ?? path.basename(url.replace(/\.git$/, '').replace(/\/+$/, ''))) || 'repository';
		const safe = (part: string) => part.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
		const base = path.join(clonesDir, safe(host || 'local'), ...name.split('/').map(safe));
		for (let i = 1; ; i++) {
			const candidate = i === 1 ? base : `${base}-${i}`;
			if (!reserved.includes(candidate) && !(await stat(candidate).catch(() => null)))
				return candidate;
		}
	}
	async function find(id: string): Promise<Repository> {
		const repo = (await store.read()).repositories.find((r) => r.id === id);
		if (!repo) throw new EngineError('repository_not_found', `Unknown repository: ${id}`);
		return repo;
	}

	async function update(
		id: string,
		change: { checkCommand?: string | null; allowedPrograms?: string[] }
	): Promise<RepositoryWithStatus> {
		await find(id);
		const next: Partial<Repository> = {};
		if (change.checkCommand !== undefined) {
			const command = change.checkCommand?.trim() || null;
			if (command && command.length > 2000) {
				throw new EngineError('invalid_input', 'The check command is too long.');
			}
			next.checkCommand = command;
		}
		if (change.allowedPrograms !== undefined) {
			const programs = change.allowedPrograms;
			if (!Array.isArray(programs) || programs.some((p) => programOf(p) !== p)) {
				throw new EngineError('invalid_input', 'Allowed programs are program names only.');
			}
			next.allowedPrograms = [...new Set(programs)].sort();
		}
		const repo = await store.update((data) => {
			const index = data.repositories.findIndex((r) => r.id === id);
			data.repositories[index] = { ...data.repositories[index], ...next };
			return data.repositories[index];
		});
		const updated = await withStatus(repo);
		options.onUpdate?.(updated);
		return updated;
	}

	return {
		async list(): Promise<RepositoryWithStatus[]> {
			const { repositories } = await store.read();
			const sorted = [...repositories].sort((a, b) => a.name.localeCompare(b.name));
			return Promise.all(sorted.map(withStatus));
		},

		async add(inputPath: string): Promise<RepositoryWithStatus> {
			if (!inputPath?.trim()) throw new EngineError('invalid_input', 'A folder path is required.');
			if (!localPaths) {
				throw new EngineError(
					'local_paths_disabled',
					'Local folders are turned off on this server. Add the repository by its URL instead.'
				);
			}
			if (resolvedRoots.length > 0) {
				// Follows symlinks: a link inside an allowed folder can't point outside it.
				const real = await resolveAllowed(inputPath.trim(), resolvedRoots).catch((error) => {
					if (error instanceof EngineError && error.code === 'folder_not_found') {
						throw new EngineError('path_not_found', error.message);
					}
					throw error;
				});
				return save(await inspectRepository(real), false);
			}
			return save(await inspectRepository(inputPath), false);
		},

		/** Clone a repository into the app's data folder and add it. */
		/**
		 * Add a repository by URL. Without `clone`, it's only registered: `git ls-remote` checks that
		 * it's reachable and finds the default branch, and the clone happens on first use.
		 */
		async addFromUrl(inputUrl: string, clone = false): Promise<RepositoryWithStatus> {
			const url = validateCloneUrl(inputUrl, localPaths);
			const { repositories } = await store.read();
			const existing = repositories.find((r) => r.managed && r.remoteUrl === url);
			if (existing) throw new EngineError('already_added', `Already added: ${url}`);

			const target = await cloneTarget(
				url,
				repositories.map((r) => r.path)
			);
			const { provider, slug } = parseRemoteUrl(url);
			const defaultBranch = await remoteDefaultBranch(url);
			const details: RepositoryDetails = {
				name: slug?.split('/').pop() ?? (path.basename(target) || 'repository'),
				path: target,
				remoteName: 'origin',
				remoteUrl: url,
				provider,
				slug,
				defaultBranch
			};
			const added = await save(details, true, { status: 'pending' });
			return clone ? this.clone(added.id) : added;
		},

		/** Clone a repository that was added by URL. Several callers share one clone. */
		async clone(id: string): Promise<RepositoryWithStatus> {
			let running = cloning.get(id);
			if (!running) {
				running = doClone(id).finally(() => cloning.delete(id));
				cloning.set(id, running);
			}
			return running;
		},

		/** One level of the folder browser (web and mobile "Browse…"). */
		async browse(target?: string) {
			if (!localPaths) {
				throw new EngineError(
					'local_paths_disabled',
					'Local folders are turned off on this server.'
				);
			}
			return browseFolders(target, resolvedRoots);
		},

		info() {
			return { localPaths, repositoryRoots: resolvedRoots };
		},

		/** Re-read the remote, default branch and status; keeps the stored entry up to date. */
		async check(id: string): Promise<RepositoryWithStatus> {
			const repo = await find(id);
			if (repo.managed && repo.cloneStatus && repo.cloneStatus !== 'ready') return withStatus(repo);
			const status = await readStatus(repo.path);
			if (!status.available) return { ...repo, status };

			const details = await inspectRepository(repo.path).catch(() => null);
			if (!details) return { ...repo, status };
			const updated = await store.update((data) => {
				const index = data.repositories.findIndex((r) => r.id === id);
				data.repositories[index] = { ...data.repositories[index], ...details };
				return data.repositories[index];
			});
			return { ...updated, status };
		},

		async candidates(): Promise<RepositoryCandidates> {
			if (resolvedRoots.length === 0) return { roots: [], candidates: [] };
			const added = new Set((await store.read()).repositories.map((r) => r.path));
			const paths = await findGitRepositories(resolvedRoots);
			return {
				roots: resolvedRoots,
				candidates: paths
					.filter((p) => !added.has(p))
					.sort()
					.map((p) => ({ path: p, name: path.basename(p) }))
			};
		},

		update,

		/** Always allow a program outside the sandbox in this repository. */
		async allowProgram(id: string, program: string): Promise<void> {
			const repo = await find(id);
			await update(id, { allowedPrograms: [...(repo.allowedPrograms ?? []), program] });
		},

		/** Forget a repository. Never touches the folder itself. */
		async remove(id: string): Promise<{ id: string }> {
			const repo = await find(id);
			await store.update((data) => {
				data.repositories = data.repositories.filter((r) => r.id !== id);
			});
			// The app's own clone goes too; a local folder you added is never touched.
			if (repo.managed && isInside(clonesDir, path.resolve(repo.path)) && repo.path !== clonesDir) {
				await rm(repo.path, { recursive: true, force: true });
			}
			return { id };
		}
	};
}
