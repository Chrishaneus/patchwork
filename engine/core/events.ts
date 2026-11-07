import type { EngineEvent } from '#lib/engine/contract.js';

export class EngineEvents {
	private listeners = new Set<(event: EngineEvent) => void>();

	subscribe(listener: (event: EngineEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: EngineEvent) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken listener must not stop the engine.
			}
		}
	}
}
