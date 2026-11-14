import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineError, type LogEntry } from '#lib/engine/contract.js';
import { withoutSecrets } from '../../core/env.js';
import {
	guidance,
	sandboxGuidance,
	short,
	type AgentRunInput,
	type AgentRunner
} from '../runner.js';
import { sandboxPolicy, type SandboxPolicy, type SandboxSupport } from '../sandbox.js';
import { startAppServer, type CodexItem, type CodexTurn } from './app-server.js';

const PROFILE = 'patchwork';

const CODEX_TARGETS: Record<string, string> = {
	'linux-x64': 'x86_64-unknown-linux-musl',
	'linux-arm64': 'aarch64-unknown-linux-musl',
	'darwin-x64': 'x86_64-apple-darwin',
	'darwin-arm64': 'aarch64-apple-darwin',
	'win32-x64': 'x86_64-pc-windows-msvc',
	'win32-arm64': 'aarch64-pc-windows-msvc'
};

/**
 * Codex's native binary, from its per-platform package, found with the host's module resolver
 * (Electron's `require.resolve`, or the server's). In a packaged app it must run from
 * app.asar.unpacked, because executables can't be started from inside the asar archive.
 */
export function findCodexBinary(resolve: (id: string) => string): string | undefined {
	const key = `${process.platform}-${process.arch}`;
	const triple = CODEX_TARGETS[key];
	if (!triple) return undefined;
	try {
		const dir = path.dirname(resolve(`@openai/codex-${key}/package.json`));
		const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
		const binary = path.join(dir, 'vendor', triple, 'bin', name);
		return binary.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
	} catch {
		return undefined;
	}
}

/**
 * Whether Codex can sandbox commands here, by running one under the same kind of rules a task
 * gets. It brings its own sandbox (Seatbelt on macOS, a bundled bubblewrap on Linux, its own on
 * Windows), but the system can forbid it, like Docker's default seccomp profile or Ubuntu's
 * AppArmor rules. On Windows, files can only be denied by MXC (Windows 11 24H2 and later) or
 * the elevated sandbox, which needs a one-time setup with administrator approval.
 */
export function codexSandboxSupport(
	executable: string | undefined,
	platform: NodeJS.Platform = process.platform
): SandboxSupport {
	const supported = { available: true, missing: [], blocked: false, setup: false };
	if (platform === 'darwin') return supported;
	if (!executable) return { ...supported, available: false };
	const dir = mkdtempSync(path.join(os.tmpdir(), 'patchwork-sandbox-'));
	try {
		const policy: SandboxPolicy = {
			writable: [dir],
			allowedDomains: ['registry.npmjs.org'],
			deniedFiles: [path.join(dir, 'denied')],
			deniedEnv: []
		};
		const config = codexSandbox(policy, platform).flatMap((override) => ['-c', override]);
		const probe = platform === 'win32' ? ['cmd', '/d', '/c', 'exit 0'] : ['true'];
		// A sandbox that isn't set up can hang instead of failing.
		const result = spawnSync(executable, ['sandbox', ...config, '--', ...probe], {
			cwd: dir,
			timeout: 30_000
		});
		if (result.status === 0) return supported;
		return { available: false, missing: [], blocked: true, setup: platform === 'win32' };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Codex's elevated Windows sandbox, set up once for this user. Windows asks for administrator
 * approval; resolves when the setup is done (or was turned down).
 */
export async function setUpCodexSandbox(executable: string) {
	await new Promise<void>((resolve, reject) =>
		execFile(
			executable,
			['sandbox', 'setup', '--elevated', '--current-user'],
			{ timeout: 10 * 60_000 },
			(error, _stdout, stderr) =>
				error ? reject(new EngineError('agent_failed', stderr.trim() || error.message)) : resolve()
		)
	);
}

/** A TOML inline table; keys are quoted because paths and hosts contain dots and colons. */
const tomlTable = (entries: Record<string, string>) =>
	`{${Object.entries(entries)
		.map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
		.join(',')}}`;

/**
 * The policy as Codex's own sandbox: a permissions profile that can read everything except the
 * denied files, write only the writable folders, and reach only the allowed hosts through
 * Codex's network proxy; the denied variables are filtered out of every command's environment.
 * Returned as `--config` overrides.
 */
export function codexSandbox(
	policy: SandboxPolicy,
	platform: NodeJS.Platform = process.platform
): string[] {
	const filesystem: Record<string, string> = { ':root': 'read' };
	for (const dir of policy.writable) filesystem[dir] = 'write';
	for (const file of policy.deniedFiles) filesystem[file] = 'deny';
	const domains = Object.fromEntries(policy.allowedDomains.map((host) => [host, 'allow']));
	const filters = Object.fromEntries(policy.deniedEnv.map((name) => [name, 'exclude']));
	const windows = platform === 'win32';
	// MXC's proxy listens on a local port, so it needs local binding.
	const network = `enabled=true,${windows ? 'allow_local_binding=true,' : ''}domains=${tomlTable(domains)}`;
	return [
		`default_permissions=${JSON.stringify(PROFILE)}`,
		`permissions.${PROFILE}.filesystem=${tomlTable(filesystem)}`,
		`permissions.${PROFILE}.network={${network}}`,
		// Without the proxy, the domain rules aren't enforced.
		'features.network_proxy=true',
		'shell_environment_policy.ignore_default_excludes=false',
		`shell_environment_policy.filters=${tomlTable(filters)}`,
		// The unelevated Windows sandbox can't deny files: use MXC, or else the elevated one.
		...(windows ? ['features.prefer_mxc=true', 'windows.sandbox="elevated"'] : [])
	];
}

/** The command Codex ran, without the `bash -lc '…'` it wraps every command in. */
export function unwrap(command: string) {
	const match = /^\S*\b(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
	return match ? match[2] : command;
}

/** Turn one Codex item, when it starts or completes, into log entries for the UI. */
export function describeCodexItem(
	stage: 'started' | 'completed',
	item: CodexItem,
	cwd: string
): Omit<LogEntry, 'at'>[] {
	// Commands are logged when they start: a failed one may never be reported as completed.
	if ('command' in item)
		return stage === 'started' ? [{ kind: 'tool', text: `$ ${short(unwrap(item.command))}` }] : [];
	if (stage !== 'completed') return [];
	if ('text' in item)
		return item.text.trim() ? [{ kind: 'assistant', text: item.text.trim() }] : [];
	if ('changes' in item)
		return item.changes.map((change) => ({
			kind: 'tool' as const,
			text: `${change.kind.type === 'add' ? 'Write' : change.kind.type === 'delete' ? 'Delete' : 'Edit'} ${
				path.relative(cwd, path.resolve(cwd, change.path)) || '.'
			}`
		}));
	if ('query' in item) return [{ kind: 'tool', text: `WebSearch ${short(item.query)}` }];
	if ('server' in item) return [{ kind: 'tool', text: `${item.server}.${item.tool}` }];
	return [];
}

/** Codex couldn't sign in to OpenAI (no API key and no `codex login`). */
export function isCodexSignInError(text: string) {
	return /\b401\b|unauthorized|not logged in|invalid api key|incorrect api key|codex login/i.test(
		text
	);
}

export function codexError(text: string) {
	return isCodexSignInError(text)
		? new EngineError(
				'agent_not_signed_in',
				'Codex has no OpenAI credentials. Add an OpenAI API key in Settings → AI agent (or set OPENAI_API_KEY), or run `codex login` on this machine.'
			)
		: new EngineError('agent_failed', text);
}

/** The variable a saved API key reaches Codex in; commands never see it. */
const KEY_ENV = 'PATCHWORK_OPENAI_API_KEY';

/**
 * A model provider that signs in with the key in `KEY_ENV`: app-server ignores `OPENAI_API_KEY`,
 * and logging in through it would replace the user's own `codex login`.
 */
const apiKeyProvider = [
	`model_providers.patchwork-openai={name="OpenAI",base_url="https://api.openai.com/v1",env_key="${KEY_ENV}",wire_api="responses"}`,
	'model_provider="patchwork-openai"'
];

/**
 * Answers Codex's requests: a command it wants to run outside the sandbox goes to the user
 * when someone can answer; anything else that would widen the sandbox is declined.
 */
async function answerCodex(
	method: string,
	params: Record<string, unknown>,
	requestApproval: AgentRunInput['requestApproval']
) {
	switch (method) {
		case 'item/commandExecution/requestApproval': {
			const command = typeof params.command === 'string' ? params.command : '';
			const plain = params.kind === 'command' && !params.networkApprovalContext && command;
			const allowed =
				plain && requestApproval
					? await requestApproval({
							command: unwrap(command),
							reason: typeof params.reason === 'string' ? params.reason.trim() || null : null
						})
					: false;
			return { decision: allowed ? 'accept' : 'decline' };
		}
		case 'item/fileChange/requestApproval':
			return { decision: 'decline' };
		case 'item/permissions/requestApproval':
			return { permissions: {}, scope: 'turn' };
		case 'execCommandApproval':
		case 'applyPatchApproval':
			return { decision: { denied: { rejection: 'Not allowed outside the sandbox.' } } };
		case 'item/tool/requestUserInput':
			return { answers: {} };
		case 'mcpServer/elicitation/request':
			return { action: 'decline', content: null, _meta: null };
		default:
			throw new Error(`Patchwork doesn’t answer ${method}.`);
	}
}

/**
 * The OpenAI agent: Codex's app-server running in the worktree, in Codex's own sandbox. Read-only
 * workflows get no writable folders, and nothing can reach GitHub or GitLab or read a
 * credential. When the user can answer, Codex may ask to run one command outside the sandbox.
 */
export function createCodexAgentRunner(
	opts: {
		executable?: string;
		/** Files the agent's commands must never read, such as the app's saved tokens. */
		protectedFiles?: string[];
	} = {}
): AgentRunner {
	return async (input) => {
		if (!opts.executable)
			throw new EngineError('agent_failed', 'Codex isn’t installed with this app.');
		const readOnly = !!input.mode && input.mode !== 'code';
		const policy = sandboxPolicy({
			cwd: input.cwd,
			protectedFiles: opts.protectedFiles ?? [],
			readOnly,
			workingCopies: input.workingCopies?.map((c) => c.path)
		});
		const env = Object.fromEntries(
			Object.entries(withoutSecrets()).filter(
				(entry): entry is [string, string] => entry[1] !== undefined
			)
		);
		// Without a key, Codex uses its own login (`codex login`).
		if (input.apiKey) env[KEY_ENV] = input.apiKey;
		const overrides = [
			...codexSandbox({ ...policy, deniedEnv: [...policy.deniedEnv, KEY_ENV] }),
			...(input.apiKey ? apiKeyProvider : [])
		];
		const canAsk = !!input.requestApproval;

		let summary = '';
		let lastError = '';
		let finish!: { resolve: (summary: string) => void; reject: (error: Error) => void };
		const finished = new Promise<string>((resolve, reject) => (finish = { resolve, reject }));
		finished.catch(() => {});
		const server = startAppServer({
			executable: opts.executable,
			args: overrides.flatMap((override) => ['-c', override]),
			env,
			onNotification(method, params) {
				if (method === 'item/started' || method === 'item/completed') {
					const stage = method === 'item/started' ? 'started' : 'completed';
					for (const entry of describeCodexItem(stage, params.item as CodexItem, input.cwd)) {
						if (entry.kind === 'assistant') summary = entry.text;
						input.log(entry);
					}
				} else if (method === 'error' && !params.willRetry) {
					const error = params.error as CodexTurn['error'];
					lastError = error?.additionalDetails || error?.message || lastError;
				} else if (method === 'turn/completed') {
					const turn = params.turn as CodexTurn;
					if (turn.status === 'completed') finish.resolve(summary);
					else
						finish.reject(
							codexError(
								turn.error?.additionalDetails ||
									turn.error?.message ||
									lastError ||
									`The turn ${turn.status}.`
							)
						);
				}
			},
			onRequest: (method, params) => answerCodex(method, params, input.requestApproval),
			onExit: (error) => finish.reject(codexError(error.message))
		});
		const abort = () => {
			finish.reject(input.signal.reason);
			server.close();
		};
		input.signal.addEventListener('abort', abort, { once: true });

		try {
			if (input.signal.aborted) throw input.signal.reason;
			await server.request('initialize', {
				clientInfo: { name: 'patchwork', title: 'Patchwork', version: '1' },
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
					optOutNotificationMethods: [
						'item/agentMessage/delta',
						'item/commandExecution/outputDelta',
						'item/reasoning/textDelta',
						'item/reasoning/summaryTextDelta'
					]
				}
			});
			server.notify('initialized');
			const { thread } = await server.request<{ thread: { id: string } }>('thread/start', {
				cwd: input.cwd,
				model: input.model,
				approvalPolicy: canAsk ? 'on-request' : 'never',
				developerInstructions: [guidance(input), sandboxGuidance(canAsk)].join('\n'),
				ephemeral: true
			});
			await server.request('turn/start', {
				threadId: thread.id,
				input: [{ type: 'text', text: input.instruction, text_elements: [] }]
			});
			input.log({ kind: 'info', text: `Agent started with Codex (${input.model})` });
			const result = await finished;
			if (!result) throw new EngineError('agent_failed', 'The agent stopped without a summary.');
			return { summary: result, costUsd: null, turns: null };
		} catch (error) {
			if (input.signal.aborted) throw input.signal.reason;
			if (!(error instanceof EngineError) && error instanceof Error)
				throw codexError(error.message);
			throw error;
		} finally {
			input.signal.removeEventListener('abort', abort);
			server.close();
		}
	};
}
