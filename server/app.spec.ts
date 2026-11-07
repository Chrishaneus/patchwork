import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, Run } from '#lib/engine/contract.js';
import { createEngine } from '../engine/index';
import { createTestAgent } from '../engine/test-agent';
import { createRepo, tempDirs } from '../engine/test-helpers';
import { createRequestHandler, type ServerOptions } from './app';

const dirs = tempDirs();
const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		s.close();
	}
	dirs.cleanup();
});

async function start(opts: Partial<ServerOptions> = {}) {
	const staticDir = dirs.make('patchwork-static-');
	mkdirSync(path.join(staticDir, '_app', 'immutable'), { recursive: true });
	writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Patchwork</title>');
	writeFileSync(path.join(staticDir, '_app', 'immutable', 'app.js'), 'console.log(1)');
	const repoRoot = dirs.make('patchwork-repos-');
	const engine = createEngine({
		dataDir: dirs.make('patchwork-data-'),
		repositoryRoots: [repoRoot],
		runAgent: createTestAgent('edit')
	});
	const server = createServer(
		createRequestHandler({ engine, staticDir, heartbeatMs: 50, ...opts })
	);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, repoRoot };
}

const call = (base: string, method: string, input: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base}/api/engine/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(input)
	});

/** Raw request, so the Host header can be set (fetch doesn't allow it). */
function rawGet(base: string, pathname: string, host: string) {
	const { port } = new URL(base);
	return new Promise<number>((resolve, reject) => {
		request({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		})
			.on('error', reject)
			.end();
	});
}

describe('static files', () => {
	it('serves files, caches immutable assets, and falls back to index.html for app routes', async () => {
		const { base } = await start();

		const asset = await fetch(`${base}/_app/immutable/app.js`);
		expect(asset.headers.get('content-type')).toContain('text/javascript');
		expect(asset.headers.get('cache-control')).toContain('immutable');

		for (const route of ['/', '/es/runs/123', '/repositories', '/..%2f..%2fetc/passwd']) {
			const res = await fetch(`${base}${route}`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('<title>Patchwork</title>');
		}
	});
});

describe('engine API', () => {
	it('runs engine calls and returns results and stable errors', async () => {
		const { base, repoRoot } = await start();
		const repoDir = path.join(repoRoot, 'widgets');
		mkdirSync(repoDir);
		createRepo(repoDir, { remote: 'git@github.com:acme/widgets.git' });

		const candidates = await (await call(base, 'listRepositoryCandidates', {})).json();
		expect(candidates.value.candidates).toEqual([{ path: repoDir, name: 'widgets' }]);

		const added = await (await call(base, 'addRepository', { path: repoDir })).json();
		expect(added).toMatchObject({ ok: true, value: { slug: 'acme/widgets' } });

		const outside = await (await call(base, 'addRepository', { path: '/tmp' })).json();
		expect(outside).toMatchObject({ ok: false, error: { code: 'outside_repository_roots' } });

		const unknown = await (await call(base, 'dropDatabase', {})).json();
		expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
	});

	it('rejects non-JSON requests and invalid bodies', async () => {
		const { base } = await start();
		const plain = await fetch(`${base}/api/engine/listRepositories`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: '{}'
		});
		expect(plain.status).toBe(415);

		const broken = await fetch(`${base}/api/engine/listRepositories`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{oops'
		});
		expect(broken.status).toBe(400);
	});

	it('streams task events while a run progresses', async () => {
		const { base, repoRoot } = await start();
		const repoDir = path.join(repoRoot, 'widgets');
		mkdirSync(repoDir);
		createRepo(repoDir, { remote: 'git@github.com:acme/widgets.git' });
		const repo = (await (await call(base, 'addRepository', { path: repoDir })).json()).value;

		const controller = new AbortController();
		const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
		expect(stream.headers.get('content-type')).toContain('text/event-stream');

		const run: Run = (
			await (
				await call(base, 'startRun', { repositoryIds: [repo.id], instruction: 'Add a changelog' })
			).json()
		).value;

		const statuses: string[] = [];
		const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		while (!statuses.includes('awaiting_review')) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += value;
			const parts = buffer.split('\n\n');
			buffer = parts.pop()!;
			for (const part of parts) {
				if (!part.startsWith('data: ')) continue;
				const event = JSON.parse(part.slice(6)) as EngineEvent;
				if (event.type === 'task.updated' && event.task.runId === run.id)
					statuses.push(event.task.status);
			}
		}
		controller.abort();

		expect(statuses).toContain('running');
		expect(statuses.at(-1)).toBe('awaiting_review');
	});
});

describe('access control', () => {
	it('without a token, answers only requests addressed to localhost', async () => {
		const { base } = await start();
		expect(await rawGet(base, '/api/health', 'localhost:8080')).toBe(200);
		expect(await rawGet(base, '/', '127.0.0.1')).toBe(200);
		expect(await rawGet(base, '/api/health', 'evil.example.com')).toBe(403);
		expect(await rawGet(base, '/', '192.168.1.20:8080')).toBe(403);
	});

	it('allows extra host names when configured', async () => {
		const { base } = await start({ allowedHosts: ['patchwork.lan'] });
		expect(await rawGet(base, '/api/health', 'patchwork.lan:8080')).toBe(200);
	});

	it('refuses cross-origin preflights without a token', async () => {
		const { base } = await start();
		const res = await fetch(`${base}/api/engine/listRepositories`, {
			method: 'OPTIONS',
			headers: { origin: 'https://evil.example.com' }
		});
		expect(res.status).toBe(403);
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('with a token, requires it on every API call and allows other hosts and origins', async () => {
		const { base } = await start({ token: 'secret-token' });

		const health = await (await fetch(`${base}/api/health`)).json();
		expect(health).toEqual({ ok: true, auth: true, authorized: false });

		expect((await call(base, 'listRepositories', {})).status).toBe(401);
		expect(
			(await call(base, 'listRepositories', {}, { authorization: 'Bearer wrong' })).status
		).toBe(401);
		expect((await fetch(`${base}/api/events`)).status).toBe(401);

		const ok = await call(base, 'listRepositories', {}, { authorization: 'Bearer secret-token' });
		expect(await ok.json()).toEqual({ ok: true, value: [] });

		expect(await rawGet(base, '/', '192.168.1.20:8080')).toBe(200);
		const preflight = await fetch(`${base}/api/engine/listRepositories`, {
			method: 'OPTIONS',
			headers: { origin: 'capacitor://localhost' }
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
	});
});
