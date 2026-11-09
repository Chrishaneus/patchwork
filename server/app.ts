import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import type { EngineEvent } from '#lib/engine/contract.js';
import { handleEngineCall, type Engine } from '../engine/index.js';

export interface ServerOptions {
	engine: Engine;
	/** The SvelteKit static build (build/). */
	staticDir: string;
	/**
	 * Access token. When set, every API call needs `Authorization: Bearer <token>` and the API can
	 * be reached from other origins (the mobile app). When unset, the server only answers requests
	 * addressed to localhost, so other machines and websites can't use it.
	 */
	token?: string;
	/** Extra host names allowed without a token, e.g. a reverse proxy's name. */
	allowedHosts?: string[];
	/**
	 * With a token, the only other origins allowed to call the API (e.g. the mobile app's
	 * `capacitor://localhost`). When empty, any origin may, since every call needs the token.
	 */
	allowedOrigins?: string[];
	/** Interval for SSE keep-alive comments. */
	heartbeatMs?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json'
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {}
) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers
	});
	res.end(JSON.stringify(body));
}

function sameToken(given: string, expected: string) {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error('too_large');
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export function createRequestHandler(options: ServerOptions): RequestListener {
	const { engine, token } = options;
	const staticRoot = path.resolve(options.staticDir);
	const allowedHosts = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? [])]);
	const heartbeatMs = options.heartbeatMs ?? 25_000;

	const allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.toLowerCase()));

	function originAllowed(origin: string) {
		return allowedOrigins.size === 0 || allowedOrigins.has(origin.toLowerCase());
	}

	const corsHeaders = (req: IncomingMessage): Record<string, string> =>
		token && req.headers.origin && originAllowed(req.headers.origin)
			? {
					'access-control-allow-origin': req.headers.origin,
					'access-control-allow-headers': 'authorization, content-type',
					'access-control-allow-methods': 'GET, POST, OPTIONS',
					vary: 'Origin'
				}
			: {};

	function hostAllowed(req: IncomingMessage) {
		if (token) return true;
		const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
		return allowedHosts.has(host);
	}

	function authorized(req: IncomingMessage) {
		if (!token) return true;
		const header = req.headers.authorization ?? '';
		return header.startsWith('Bearer ') && sameToken(header.slice('Bearer '.length), token);
	}

	async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
		let filePath = path.normalize(path.join(staticRoot, decodeURIComponent(pathname)));
		const inside = filePath.startsWith(staticRoot + path.sep);
		let info = inside ? await stat(filePath).catch(() => null) : null;
		if (!info?.isFile()) {
			// Client-side routes (e.g. /es/runs/123) fall back to the SPA entry point.
			filePath = path.join(staticRoot, 'index.html');
			info = await stat(filePath).catch(() => null);
			if (!info) return sendJson(res, 404, { error: 'not_found' });
		}
		const immutable = pathname.startsWith('/_app/immutable/');
		res.writeHead(200, {
			'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
			'content-length': info.size,
			'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
			'x-content-type-options': 'nosniff'
		});
		if (req.method === 'HEAD') return res.end();
		createReadStream(filePath).pipe(res);
	}

	function streamEvents(req: IncomingMessage, res: ServerResponse) {
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
			...corsHeaders(req)
		});
		res.write(': connected\n\n');
		const send = (event: EngineEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
		const unsubscribe = engine.subscribe(send);
		const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
		req.on('close', () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	}

	return async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://localhost');
			const { pathname } = url;

			if (!hostAllowed(req)) {
				return sendJson(res, 403, {
					error: 'host_not_allowed',
					message: 'Set PATCHWORK_TOKEN to use the server from other machines.'
				});
			}

			if (!pathname.startsWith('/api/')) {
				if (req.method !== 'GET' && req.method !== 'HEAD')
					return sendJson(res, 405, { error: 'method_not_allowed' });
				return await serveStatic(req, res, pathname);
			}

			const cors = corsHeaders(req);
			if (req.method === 'OPTIONS') {
				res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, cors);
				return res.end();
			}

			if (pathname === '/api/health' && req.method === 'GET') {
				return sendJson(
					res,
					200,
					{ ok: true, auth: Boolean(token), authorized: authorized(req) },
					cors
				);
			}

			if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' }, cors);

			if (pathname === '/api/events' && req.method === 'GET') return streamEvents(req, res);

			const match = /^\/api\/engine\/([A-Za-z]+)$/.exec(pathname);
			if (match && req.method === 'POST') {
				// Requiring JSON makes browsers preflight cross-site requests, which we refuse
				// without a token, so other websites can't drive the engine.
				if (!req.headers['content-type']?.startsWith('application/json')) {
					return sendJson(res, 415, { error: 'unsupported_media_type' }, cors);
				}
				let input: unknown;
				try {
					const body = await readBody(req);
					input = body ? JSON.parse(body) : undefined;
				} catch (error) {
					const tooLarge = error instanceof Error && error.message === 'too_large';
					return sendJson(
						res,
						tooLarge ? 413 : 400,
						{ error: tooLarge ? 'too_large' : 'invalid_json' },
						cors
					);
				}
				return sendJson(res, 200, await handleEngineCall(engine, match[1], input), cors);
			}

			return sendJson(res, 404, { error: 'not_found' }, cors);
		} catch (error) {
			// The details (paths, stack) stay in the server's log; the caller only learns it failed.
			console.error(`${req.method} ${req.url} failed:`, error);
			if (!res.headersSent) {
				sendJson(res, 500, {
					error: 'internal',
					message: 'Something went wrong on the server. Its log has the details.'
				});
			} else res.end();
		}
	};
}
