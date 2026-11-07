import { defineConfig } from '@playwright/test';

// Launches the packaged-style Electron app against build/. Run via `npm run test:electron`.
export default defineConfig({
	testDir: '.',
	testMatch: '**/*.electron.ts',
	// Each test starts a full Electron app; more at once made windows occasionally close under
	// load on smaller machines (seen on WSL with 6 cores).
	workers: 2
});
