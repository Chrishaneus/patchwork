import { randomUUID } from 'node:crypto';
import { EngineError, type InstructionTemplate } from '#lib/engine/contract.js';
import type { JsonStore } from '../core/store.js';

/** Saved instructions you can start a change from. */
export function createTemplateService(store: JsonStore) {
	return {
		async list(): Promise<InstructionTemplate[]> {
			return [...(await store.read()).templates].sort((a, b) => a.name.localeCompare(b.name));
		},

		/** Create a template, or update it when `id` is given. */
		async save(input: { id?: string; name: string; instruction: string }) {
			const cleanName = input.name?.trim();
			const cleanInstruction = input.instruction?.trim();
			if (!cleanName || !cleanInstruction) {
				throw new EngineError('invalid_input', 'A template needs a name and an instruction.');
			}
			return store.update((data) => {
				const existing = input.id ? data.templates.find((t) => t.id === input.id) : undefined;
				if (input.id && !existing) {
					throw new EngineError('invalid_input', `Unknown template: ${input.id}`);
				}
				if (existing) {
					existing.name = cleanName;
					existing.instruction = cleanInstruction;
					return { ...existing };
				}
				const created = { id: randomUUID(), name: cleanName, instruction: cleanInstruction };
				data.templates.push(created);
				return created;
			});
		},

		async remove(id: string) {
			await store.update((data) => {
				data.templates = data.templates.filter((t) => t.id !== id);
			});
			return { id };
		}
	};
}
