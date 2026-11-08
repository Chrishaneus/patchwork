import { randomUUID } from 'node:crypto';
import {
	EngineError,
	type ApprovalAnswer,
	type ApprovalRequest,
	type Task
} from '#lib/engine/contract.js';
import { programOf } from '../agent/approvals.js';
import type { createRunContextBase } from './context.js';

type Context = ReturnType<typeof createRunContextBase>;

/**
 * Requests from agents to run a command outside the sandbox. The request shows on the task
 * (`task.approval`) until you answer it; a cancel or the task's time limit counts as no. Any
 * agent runner can ask through `requestApproval`.
 */
export function createApprovals(ctx: Context) {
	const waiting = new Map<string, { id: string; answer: (answer: ApprovalAnswer) => void }>();

	async function request(
		taskId: string,
		ask: { command: string; reason: string | null },
		signal: AbortSignal
	): Promise<boolean> {
		const task = await ctx.findTask(taskId);
		const repo = await ctx.findRepository(task.repositoryId);
		const program = programOf(ask.command);
		if (program && repo?.allowedPrograms?.includes(program)) {
			ctx.log(taskId, {
				kind: 'info',
				text: `Running outside the sandbox: ${program} is always allowed in this repository.`
			});
			return true;
		}
		if (signal.aborted || waiting.has(taskId)) return false;

		const approval: ApprovalRequest = {
			id: randomUUID(),
			command: ask.command,
			reason: ask.reason?.trim() || null,
			program,
			at: new Date().toISOString()
		};
		// Wait before showing the request, so an answer can't arrive before anyone listens.
		const answered = new Promise<ApprovalAnswer>((resolve) => {
			const onAbort = () => resolve('deny');
			signal.addEventListener('abort', onAbort, { once: true });
			waiting.set(taskId, {
				id: approval.id,
				answer: (value) => {
					signal.removeEventListener('abort', onAbort);
					resolve(value);
				}
			});
		});
		await ctx.updateTask(taskId, { approval });
		const answer = await answered;
		waiting.delete(taskId);
		if (signal.aborted) {
			await ctx.updateTask(taskId, { approval: null });
			return false;
		}
		ctx.log(taskId, {
			kind: 'info',
			text:
				answer === 'always'
					? `You allowed ${program} outside the sandbox in this repository.`
					: answer === 'once'
						? 'You allowed the command outside the sandbox, this once.'
						: 'You didn’t allow the command outside the sandbox.'
		});
		return answer !== 'deny';
	}

	async function answer(input: {
		taskId: string;
		approvalId: string;
		answer: ApprovalAnswer;
	}): Promise<Task> {
		if (!['once', 'always', 'deny'].includes(input.answer)) {
			throw new EngineError('invalid_input', 'Answer once, always or deny.');
		}
		const pending = waiting.get(input.taskId);
		if (!pending || pending.id !== input.approvalId) {
			throw new EngineError('invalid_state', 'The agent isn’t waiting for this anymore.');
		}
		const task = await ctx.findTask(input.taskId);
		if (input.answer === 'always' && !task.approval?.program) {
			throw new EngineError('invalid_input', 'This command can only be allowed once.');
		}
		const program = task.approval?.program;
		if (input.answer === 'always' && program) {
			await ctx.deps.allowProgram(task.repositoryId, program);
		}
		const updated = await ctx.updateTask(input.taskId, { approval: null });
		pending.answer(input.answer);
		return updated;
	}

	return { request, answer };
}
