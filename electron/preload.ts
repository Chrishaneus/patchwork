// Preload script: the only bridge between the web app and Electron. Keep it narrow.
import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronBridge } from '../src/lib/engine/bridge';
import type { EngineEvent } from '../src/lib/engine/contract';

const bridge: ElectronBridge = {
	platform: process.platform,
	engine: {
		invoke: (method, input) => ipcRenderer.invoke('engine:invoke', method, input),
		onEvent: (listener) => {
			const handler = (_event: Electron.IpcRendererEvent, payload: EngineEvent) =>
				listener(payload);
			ipcRenderer.on('engine:event', handler);
			return () => ipcRenderer.removeListener('engine:event', handler);
		}
	},
	host: {
		pickDirectory: () => ipcRenderer.invoke('host:pickDirectory')
	}
};

contextBridge.exposeInMainWorld('electron', bridge);
