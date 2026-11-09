/**
 * Models offered in Settings, grouped by provider. The provider decides the agent: Anthropic
 * models run in Claude Code, OpenAI models in Codex. Any other model ID can still be typed in
 * ("Custom model ID…").
 */
export type AgentProvider = 'anthropic' | 'openai';

export interface ModelOption {
	id: string;
	name: string;
	/** A few words on when to pick it. */
	note: string;
}

export interface ModelProvider {
	id: AgentProvider;
	name: string;
	/** Current models, shown first. */
	models: ModelOption[];
	/** Previous generations, in a nested submenu. */
	older: ModelOption[];
}

export const modelProviders: ModelProvider[] = [
	{
		id: 'anthropic',
		name: 'Anthropic',
		models: [
			{
				id: 'claude-opus-5-5',
				name: 'Claude Opus 5.5',
				note: 'Default: strong at coding, good value'
			},
			{ id: 'claude-fable-5-1', name: 'Claude Fable 5.1', note: 'Most capable, highest cost' },
			{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Fast and capable, lower cost' },
			{
				id: 'claude-haiku-5-5',
				name: 'Claude Haiku 5.5',
				note: 'Fastest and cheapest, for small changes'
			}
		],
		older: [
			{ id: 'claude-fable-5', name: 'Claude Fable 5', note: 'Previous Fable' },
			{ id: 'claude-opus-5', name: 'Claude Opus 5', note: 'Previous Opus' },
			{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', note: 'Previous Sonnet' },
			{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8', note: 'Older Opus' },
			{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', note: 'Older Haiku' }
		]
	},
	{
		id: 'openai',
		name: 'OpenAI (Codex)',
		models: [
			{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', note: 'Strong at long coding tasks; paid plans' },
			{ id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', note: 'Fast and efficient; paid plans' },
			{ id: 'gpt-6-luna', name: 'GPT-6 Luna', note: 'Cheapest; on every plan' }
		],
		older: [
			{ id: 'gpt-6-sol', name: 'GPT-6 Sol', note: 'Previous Sol' },
			{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', note: 'Previous Terra' },
			{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', note: 'Previous Luna' },
			{ id: 'gpt-5.5', name: 'GPT-5.5', note: 'API keys only' }
		]
	}
];

/** The model Auto mode uses to pick a workflow, unless Settings says otherwise. */
export const defaultAutoModeModel = 'claude-haiku-5-5';

/** The catalogue entry for a model ID, with its provider; undefined for custom IDs. */
export function findModel(id: string): { provider: ModelProvider; model: ModelOption } | undefined {
	for (const provider of modelProviders) {
		const model = [...provider.models, ...provider.older].find((m) => m.id === id);
		if (model) return { provider, model };
	}
	return undefined;
}

/** Which provider, and so which agent, runs a model; custom IDs go by their name. */
export function providerOf(model: string): AgentProvider {
	return (
		findModel(model)?.provider.id ?? (/^(gpt-|o\d|codex)/i.test(model) ? 'openai' : 'anthropic')
	);
}
