import { providerOf } from '#lib/engine/models.js';
import { createClaudeAgentRunner } from './claude/index.js';
import { createCodexAgentRunner } from './codex/index.js';
import type { AgentRunner } from './runner.js';

/** Runs each task with the agent for its model's provider: Claude Code or Codex. */
export function createAgentRunner(
	opts: {
		claude?: AgentRunner;
		codex?: AgentRunner;
		/** Claude Code's and Codex's binaries, for packaged apps. */
		claudeExecutable?: string;
		codexExecutable?: string;
		/** Files the agent's commands must never read, such as the app's saved tokens. */
		protectedFiles?: string[];
	} = {}
): AgentRunner {
	const claude =
		opts.claude ??
		createClaudeAgentRunner({
			executable: opts.claudeExecutable,
			protectedFiles: opts.protectedFiles
		});
	const codex =
		opts.codex ??
		createCodexAgentRunner({
			executable: opts.codexExecutable,
			protectedFiles: opts.protectedFiles
		});
	return (input) => (providerOf(input.model) === 'openai' ? codex(input) : claude(input));
}
