import type { Approach } from '#lib/engine/contract.js';
import { m } from '#lib/paraglide/messages.js';

/** The instruction for a code run that builds an approach from an exploration. */
export function approachInstruction(idea: string, approach: Approach): string {
	return [
		idea,
		m.explore_build_prompt({ title: approach.title }),
		approach.summary,
		approach.details
	]
		.filter(Boolean)
		.join('\n\n');
}
