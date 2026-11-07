import { spawn } from 'node:child_process';
import type { TaskChecks } from '#lib/engine/contract.js';
import type { RunContext } from './context.js';

const MAX_OUTPUT = 16 * 1024;

/** Variables the app itself uses; a repository's check command never needs them. */
const SECRET_ENV = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'PATCHWORK_TOKEN'];

export interface CheckResult {
	exitCode: number | null;
	/** The end of stdout and stderr combined. */
	output: string;
	/** True when the command was stopped (cancelled or out of time) rather than finishing. */
	stopped: boolean;
}

/**
 * Run a repository's check command in `cwd` through the shell. The whole process tree is killed
 * when `signal` aborts.
 */
export function runCheckCommand(opts: {
	cwd: string;
	command: string;
	signal: AbortSignal;
}): Promise<CheckResult> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', FORCE_COLOR: '0' };
		for (const name of SECRET_ENV) delete env[name];

		const windows = process.platform === 'win32';
		const child = windows
			? spawn(opts.command, { cwd: opts.cwd, env, shell: true, windowsHide: true })
			: // Its own process group, so the shell and everything it started can be killed together.
				spawn('sh', ['-c', opts.command], { cwd: opts.cwd, env, detached: true });

		let output = '';
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);

		let stopped = false;
		const kill = () => {
			stopped = true;
			try {
				if (windows) child.kill();
				else if (child.pid) process.kill(-child.pid, 'SIGKILL');
			} catch {
				// Already gone.
			}
		};
		if (opts.signal.aborted) kill();
		else opts.signal.addEventListener('abort', kill, { once: true });

		child.on('error', (error) => {
			opts.signal.removeEventListener('abort', kill);
			resolve({ exitCode: null, output: `${output}\n${error.message}`.trim(), stopped });
		});
		child.on('close', (code) => {
			opts.signal.removeEventListener('abort', kill);
			resolve({ exitCode: code, output: output.trimEnd(), stopped });
		});
	});
}

/**
 * Run the repository's check command in the worktree and record the result on the task.
 * Resolves to null when the command was stopped (cancel or time limit).
 */
export async function performChecks(
	ctx: RunContext,
	taskId: string,
	worktreePath: string,
	command: string,
	signal: AbortSignal
): Promise<TaskChecks | null> {
	const started: TaskChecks = {
		status: 'running',
		command,
		exitCode: null,
		output: '',
		startedAt: new Date().toISOString(),
		finishedAt: null
	};
	await ctx.updateTask(taskId, { status: 'checking', checks: started });
	ctx.log(taskId, { kind: 'tool', text: `$ ${command}` });
	const result = await runCheckCommand({ cwd: worktreePath, command, signal });
	const checks: TaskChecks = {
		...started,
		status: !result.stopped && result.exitCode === 0 ? 'passed' : 'failed',
		exitCode: result.exitCode,
		output: result.stopped ? `${result.output}\n(stopped)`.trim() : result.output,
		finishedAt: new Date().toISOString()
	};
	await ctx.updateTask(taskId, { checks });
	if (result.stopped) return null;
	ctx.log(taskId, {
		kind: checks.status === 'passed' ? 'info' : 'error',
		text:
			checks.status === 'passed'
				? 'Checks passed.'
				: `Checks failed (exit code ${result.exitCode ?? 'unknown'}).`
	});
	return checks;
}
