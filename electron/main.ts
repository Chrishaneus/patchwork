// Electron main process: serves the SvelteKit static build (build/) over app://, opens the window,
// and hosts the engine behind one generic IPC channel.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyLegacyEnv, migrateDataDir } from '../engine/core/env';
import { classifyByRules, createEngine, handleEngineCall, type SecretStore } from '../engine/index';
import { createTestAgent } from '../engine/agent/test-agent';

applyLegacyEnv();

// Bundled to dist-electron/, so the app root is one level up.
const appRoot = path.join(__dirname, '..');
const buildDir = path.join(appRoot, 'build');

// Pass --dev-url=http://localhost:5173 to load the Vite dev server instead of build/.
const devUrl = process.argv.find((arg) => arg.startsWith('--dev-url='))?.slice('--dev-url='.length);
const appOrigin = 'app://bundle';
const isInternalUrl = (url: string) => url.startsWith(devUrl ?? appOrigin);

protocol.registerSchemesAsPrivileged([
	{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

function serveBuild() {
	protocol.handle('app', (request) => {
		const { pathname } = new URL(request.url);
		const filePath = path.normalize(path.join(buildDir, decodeURIComponent(pathname)));
		const insideBuild = filePath.startsWith(buildDir + path.sep);
		const isFile = insideBuild && existsSync(filePath) && statSync(filePath).isFile();
		// Unknown paths (client-side routes like /es) fall back to the SPA entry point.
		const target = isFile ? filePath : path.join(buildDir, 'index.html');
		return net.fetch(pathToFileURL(target).toString());
	});
}

/**
 * Secrets in one file in the app's data folder, readable only by the current user. They are
 * encrypted with the OS keychain (safeStorage) when one exists; on systems without a keychain
 * (e.g. WSL or a bare Linux desktop) they are stored as plain text, like the GitHub and Claude
 * CLIs do, and the Settings page says so.
 */
function createFileSecrets(file: string): SecretStore {
	const encrypted = safeStorage.isEncryptionAvailable();
	const readAll = async (): Promise<Record<string, string>> => {
		try {
			return JSON.parse(await readFile(file, 'utf8'));
		} catch {
			return {};
		}
	};
	return {
		encrypted,
		async get(name) {
			const stored = (await readAll())[name];
			if (!stored) return null;
			if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
			if (!stored.startsWith('enc:') || !safeStorage.isEncryptionAvailable()) return null;
			try {
				return safeStorage.decryptString(Buffer.from(stored.slice('enc:'.length), 'base64'));
			} catch {
				return null;
			}
		},
		async set(name, value) {
			const all = await readAll();
			if (value === null) delete all[name];
			else
				all[name] = encrypted
					? `enc:${safeStorage.encryptString(value).toString('base64')}`
					: `plain:${value}`;
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, JSON.stringify(all), { mode: 0o600 });
		}
	};
}

/**
 * The Claude Code binary ships in a per-platform package. In a packaged app it must run from
 * app.asar.unpacked, because executables can't be started from inside the asar archive.
 */
function findAgentExecutable(): string | undefined {
	try {
		const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
		const dir = path.dirname(require.resolve(pkg));
		const binary = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
		return binary.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
	} catch {
		return undefined;
	}
}

function registerIpc() {
	// PATCHWORK_DATA_DIR lets tests and power users keep data somewhere else.
	const dataDir = process.env.PATCHWORK_DATA_DIR ?? path.join(app.getPath('userData'), 'engine');
	// Before the rename to Patchwork, Electron kept the data in a folder named "ai-tool".
	if (!process.env.PATCHWORK_DATA_DIR) {
		migrateDataDir(path.join(app.getPath('appData'), 'ai-tool', 'engine'), dataDir);
	}
	const engine = createEngine({
		dataDir,
		secrets: createFileSecrets(path.join(dataDir, 'secrets.json')),
		agentExecutable: findAgentExecutable(),
		// PATCHWORK_GITHUB_API_URL points at GitHub Enterprise or the local fake GitHub (npm run sandbox).
		githubApiUrl: process.env.PATCHWORK_GITHUB_API_URL || undefined,
		gitlabApiUrl: process.env.PATCHWORK_GITLAB_API_URL || undefined,
		githubClientId: process.env.PATCHWORK_GITHUB_CLIENT_ID || undefined,
		githubWebUrl: process.env.PATCHWORK_GITHUB_WEB_URL || undefined,
		// End-to-end tests use a scripted agent instead of the real model.
		runAgent: process.env.PATCHWORK_TEST_AGENT
			? createTestAgent(process.env.PATCHWORK_TEST_AGENT)
			: undefined,
		classifyMode: process.env.PATCHWORK_TEST_AGENT ? classifyByRules : undefined
	});

	// Push task updates and log lines to every window.
	engine.subscribe((event) => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engine:event', event);
	});

	// Only our own pages may call into the engine.
	const fromApp = (event: Electron.IpcMainInvokeEvent) =>
		!!event.senderFrame && isInternalUrl(event.senderFrame.url);

	ipcMain.handle('engine:invoke', (event, method: unknown, input: unknown) => {
		if (!fromApp(event)) {
			return { ok: false, error: { code: 'internal', message: 'Untrusted sender' } };
		}
		return handleEngineCall(engine, method, input);
	});

	ipcMain.handle('host:pickDirectory', async (event) => {
		if (!fromApp(event)) return null;
		const win = BrowserWindow.fromWebContents(event.sender);
		const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
		const result = win
			? await dialog.showOpenDialog(win, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
}

function createWindow() {
	// Tests set PATCHWORK_HIDE_WINDOW=1 so no window pops up on the desktop while they run.
	const hidden = process.env.PATCHWORK_HIDE_WINDOW === '1';
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		show: !hidden,
		// Matches the dark theme (the default) so the window doesn't flash white while loading.
		backgroundColor: '#0a0a0a',
		webPreferences: {
			// Hidden (test) windows render offscreen: frames keep coming, so animation frames and
			// timers run at full speed, but nothing is drawn on the desktop.
			offscreen: hidden,
			backgroundThrottling: !hidden,
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false
		}
	});

	// Open external links in the system browser instead of inside the app.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (isInternalUrl(url)) return;
		event.preventDefault();
		if (/^https?:/.test(url)) shell.openExternal(url);
	});

	win.loadURL(devUrl ?? `${appOrigin}/`);
}

app.whenReady().then(() => {
	if (!devUrl) serveBuild();
	registerIpc();
	createWindow();
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
