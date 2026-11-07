/**
 * Models offered in Settings, grouped by provider. The agent is the Claude Agent SDK, so only
 * Anthropic models run today; another provider needs its own agent runner in the engine first.
 * Any other model ID can still be typed in ("Custom model ID…").
 */
export interface ModelOption {
	id: string;
	name: string;
	/** A few words on when to pick it. */
	note: string;
}

export interface ModelProvider {
	id: string;
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
	}
];

/** The catalogue entry for a model ID, with its provider; undefined for custom IDs. */
export function findModel(id: string): { provider: ModelProvider; model: ModelOption } | undefined {
	for (const provider of modelProviders) {
		const model = [...provider.models, ...provider.older].find((m) => m.id === id);
		if (model) return { provider, model };
	}
	return undefined;
}
