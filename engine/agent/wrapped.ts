import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withoutSecrets } from '../core/env.js';
import { findClaudeBinary } from './claude/index.js';
import {
	installCommand,
	onPath,
	sandboxSupport,
	type SandboxPolicy,
	type SandboxSupport
} from './sandbox.js';

/**
 * Agents with no sandbox of their own run whole inside Anthropic's sandbox runtime (`srt`): the
 * agent and every command it starts get `sandboxPolicy`, enforced by bubblewrap (Linux) or
 * Seatbelt (macOS), with a proxy that lets through only the allowed hosts.
 *
 * The agent itself needs a little more than its commands would: its API host, its key and a
 * folder for its own state. Its key is masked: inside the sandbox the variable holds a
 * placeholder, and the proxy puts the real key back only on requests to the API hosts, so neither
 * the agent nor its commands can read it or send it anywhere else.
 */
export interface WrappedAgent {
	/** Hosts the agent's model API is on: reachable, and the only ones its key is sent to. */
	apiHosts: string[];
	/** The agent's key, by variable name; masked inside the sandbox. */
	key?: { env: string; value: string };
	/** Folders the agent keeps its own state in (sessions, caches); writable. */
	stateDirs?: string[];
}

/** srt's settings for one run. */
export function srtConfig(policy: SandboxPolicy, agent: WrappedAgent, ripgrep?: Ripgrep) {
	const keyEnv = agent.key?.env;
	return {
		...(ripgrep ? { ripgrep } : {}),
		network: {
			allowedDomains: [...new Set([...policy.allowedDomains, ...agent.apiHosts])],
			deniedDomains: [],
			strictAllowlist: true,
			// Terminating TLS lets the proxy put the real key into requests to the API hosts.
			...(keyEnv ? { tlsTerminate: {} } : {})
		},
		filesystem: {
			denyRead: policy.deniedFiles,
			allowRead: [],
			allowWrite: [...policy.writable, ...(agent.stateDirs ?? [])],
			denyWrite: []
		},
		credentials: {
			envVars: [
				...policy.deniedEnv
					.filter((name) => name !== keyEnv)
					.map((name) => ({ name, mode: 'deny' as const })),
				...(keyEnv ? [{ name: keyEnv, mode: 'mask' as const, injectHosts: agent.apiHosts }] : [])
			],
			files: []
		}
	};
}

const require = createRequire(import.meta.url);

/** How srt runs ripgrep, which it uses to find the denied files. */
export type Ripgrep = { command: string; argv0?: string };

/**
 * ripgrep for srt: the Claude Code binary the app already ships runs as ripgrep when started
 * under the name `rg`, so nothing has to be installed. A system `rg` is the fallback.
 */
export function findRipgrep(claude = findClaudeBinary(require.resolve)): Ripgrep | undefined {
	if (claude && existsSync(claude)) return { command: claude, argv0: 'rg' };
	return onPath('rg') ? { command: 'rg' } : undefined;
}

/**
 * Whether srt can run here: what Claude Code's sandbox needs (bubblewrap and socat on Linux),
 * plus ripgrep on Linux (macOS matches denied paths in its Seatbelt profile instead). Windows
 * isn't supported yet.
 */
export function srtSupport(
	platform: NodeJS.Platform = process.platform,
	/** null: there is none. */
	ripgrep: Ripgrep | null = findRipgrep() ?? null
): SandboxSupport {
	const base = sandboxSupport(platform);
	if (platform !== 'linux' || ripgrep) return base;
	const missing = [...base.missing, 'ripgrep'];
	return { ...base, available: false, missing, install: installCommand(missing) };
}

/**
 * srt's command-line entry point, from the installed package; in a packaged app, from
 * app.asar.unpacked, since srt starts helper binaries from its own folder.
 */
export function srtCli() {
	const cli = path.join(path.dirname(require.resolve('@anthropic-ai/sandbox-runtime')), 'cli.js');
	return cli.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * Under Electron (run as Node), command-line parsers such as commander (srt) and yargs (Gemini
 * CLI) take it for a packaged single-file app and read the script's own path as the first
 * argument. This launcher makes it look like plain Node: it drops itself from `process.argv`,
 * sets `process.defaultApp`, which both check, and imports the script.
 */
const ELECTRON_LAUNCHER = [
	'process.defaultApp = true;',
	'process.argv.splice(1, 1);',
	"const { pathToFileURL } = await import('node:url');",
	'await import(pathToFileURL(process.argv[1]).href);',
	''
].join('\n');

export interface WrappedCommand {
	command: string;
	args: string[];
	env: Record<string, string | undefined>;
	/** Removes the settings file once the agent has exited. */
	cleanup: () => void;
}

/**
 * The command to spawn instead of `command args`: srt with this run's settings, then the agent.
 * The environment has no secrets but the agent's key, which srt masks.
 */
export function wrapInSandbox(opts: {
	policy: SandboxPolicy;
	agent: WrappedAgent;
	command: string;
	args: string[];
	env?: Record<string, string | undefined>;
}): WrappedCommand {
	// Outside every writable folder, so nothing in the sandbox can change its own rules.
	const dir = mkdtempSync(path.join(tmpdir(), 'patchwork-srt-'));
	const settings = path.join(dir, 'settings.json');
	// srt points TMPDIR at /tmp/claude, which only exists where Claude Code made it; each run
	// gets a temp folder of its own instead (CLAUDE_CODE_TMPDIR is srt's name for it).
	const temp = mkdtempSync(path.join(tmpdir(), 'patchwork-srt-tmp-'));
	const agent = { ...opts.agent, stateDirs: [...(opts.agent.stateDirs ?? []), temp] };
	const config = srtConfig(opts.policy, agent, findRipgrep());
	writeFileSync(settings, JSON.stringify(config), { mode: 0o600 });
	// Scripts run by this Node (srt itself, and an agent started the same way) go through the
	// launcher under Electron. It sits beside the settings: readable inside, not writable.
	let script: string[] = [];
	if (process.versions.electron) {
		const launcher = path.join(dir, 'launch.mjs');
		writeFileSync(launcher, ELECTRON_LAUNCHER, { mode: 0o644 });
		script = [launcher];
	}
	const inner = opts.command === process.execPath ? [...script, ...opts.args] : opts.args;
	const key = opts.agent.key;
	return {
		command: process.execPath,
		args: [...script, srtCli(), '--settings', settings, '--', opts.command, ...inner],
		env: {
			...withoutSecrets({}, opts.env ?? process.env),
			// Under Electron, run srt as plain Node.
			ELECTRON_RUN_AS_NODE: '1',
			// The sandbox has no network but srt's proxy, and Node's fetch ignores HTTPS_PROXY
			// unless told (Node 24+); without it, agents written in Node can't reach their API.
			NODE_USE_ENV_PROXY: '1',
			CLAUDE_CODE_TMPDIR: temp,
			...(key ? { [key.env]: key.value } : {})
		},
		cleanup: () => {
			rmSync(dir, { recursive: true, force: true });
			rmSync(temp, { recursive: true, force: true });
		}
	};
}
