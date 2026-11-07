import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Playwright global setup: empty the folders where earlier runs left repositories. Tests name
 * them by time, so they would pile up. The test servers are already running with `.e2e/repos` as
 * their allowed folder, so the folders themselves stay; only their contents go.
 */
export default function setup() {
	for (const dir of ['.e2e/repos', '.e2e/remotes']) {
		mkdirSync(dir, { recursive: true });
		for (const entry of readdirSync(dir)) {
			rmSync(path.join(dir, entry), { recursive: true, force: true });
		}
	}
}
