import { providerOf } from '#lib/engine/models.js';
import { createClaudeAgentRunner } from './claude/index.js';
import { createCodexAgentRunner } from './codex/index.js';
import { createGeminiAgentRunner } from './gemini/index.js';
import type { AgentRunner } from './runner.js';

/** Runs each task with the agent for its model's provider: Claude Code, Codex or Gemini CLI. */
export function createAgentRunner(
	opts: {
		claude?: AgentRunner;
		codex?: AgentRunner;
		gemini?: AgentRunner;
		/** Claude Code's and Codex's binaries and Gemini CLI's script, for packaged apps. */
		claudeExecutable?: string;
		codexExecutable?: string;
		geminiCli?: string;
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
	const gemini =
		opts.gemini ??
		createGeminiAgentRunner({ cli: opts.geminiCli, protectedFiles: opts.protectedFiles });
	return (input) => {
		const provider = providerOf(input.model);
		return provider === 'openai'
			? codex(input)
			: provider === 'google'
				? gemini(input)
				: claude(input);
	};
}
