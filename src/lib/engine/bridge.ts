import type { EngineEventSource, EngineTransport } from './contract';

/** What `electron/preload.ts` exposes as `window.electron`. */
export interface ElectronBridge {
	platform: string;
	engine: { invoke: EngineTransport; onEvent: EngineEventSource };
	host: { pickDirectory: () => Promise<string | null> };
}
