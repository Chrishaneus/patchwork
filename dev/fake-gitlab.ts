// A fake GitLab for tests: the merge-request endpoints of GitLab's REST API (v4) that the engine
// uses. Projects are addressed by their URL-encoded path, as GitLab allows.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMergeRequest {
	project: string;
	iid: number;
	title: string;
	description: string;
	source_branch: string;
	target_branch: string;
	state: 'opened' | 'closed' | 'merged';
	draft: boolean;
	web_url: string;
}

export interface FakeGitLab {
	/** API base URL, i.e. ending in /api/v4. */
	apiUrl: string;
	mergeRequests: FakeMergeRequest[];
	/** Comments posted on merge requests (reviews). */
	notes: { project: string; iid: number; id: number; body: string }[];
	setState: (project: string, iid: number, state: FakeMergeRequest['state']) => void;
	close: () => Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
};

export async function startFakeGitLab(): Promise<FakeGitLab> {
	const mergeRequests: FakeMergeRequest[] = [];
	const notes: FakeGitLab['notes'] = [];
	let base = '';

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		// /api/v4/projects/:encodedPath/merge_requests[/:iid]
		const match = /^\/api\/v4\/projects\/([^/]+)\/merge_requests(?:\/(\d+))?(\/notes)?$/.exec(
			url.pathname
		);
		if (!match) return send(res, 404, { message: '404 Not Found' });
		if (!req.headers['private-token']) return send(res, 401, { message: '401 Unauthorized' });
		const project = decodeURIComponent(match[1]);

		if (match[3]) {
			if (req.method !== 'POST' || !match[2]) return send(res, 405, { message: 'Not allowed' });
			const mr = mergeRequests.find((m) => m.project === project && m.iid === Number(match[2]));
			if (!mr) return send(res, 404, { message: '404 Not found' });
			let raw = '';
			for await (const chunk of req) raw += chunk;
			const note = {
				project,
				iid: mr.iid,
				id: notes.length + 1,
				body: JSON.parse(raw || '{}').body
			};
			notes.push(note);
			return send(res, 201, { id: note.id, body: note.body });
		}

		if (req.method === 'GET' && match[2]) {
			const mr = mergeRequests.find((m) => m.project === project && m.iid === Number(match[2]));
			return mr ? send(res, 200, mr) : send(res, 404, { message: '404 Not found' });
		}
		if (req.method === 'GET') {
			const state = url.searchParams.get('state');
			const source = url.searchParams.get('source_branch');
			return send(
				res,
				200,
				mergeRequests.filter(
					(m) =>
						m.project === project &&
						(!state || m.state === state) &&
						(!source || m.source_branch === source)
				)
			);
		}
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const input = JSON.parse(raw || '{}') as {
			source_branch?: string;
			target_branch?: string;
			title?: string;
			description?: string;
		};
		if (!input.source_branch || !input.target_branch || !input.title) {
			return send(res, 400, { message: 'source_branch, target_branch and title are required' });
		}
		if (
			mergeRequests.some(
				(m) =>
					m.project === project && m.source_branch === input.source_branch && m.state === 'opened'
			)
		) {
			return send(res, 409, {
				message: ['Another open merge request already exists for this source branch']
			});
		}
		const iid = mergeRequests.filter((m) => m.project === project).length + 1;
		const mr: FakeMergeRequest = {
			project,
			iid,
			title: input.title,
			description: input.description ?? '',
			source_branch: input.source_branch,
			target_branch: input.target_branch,
			state: 'opened',
			draft: /^(draft|wip):/i.test(input.title),
			web_url: `${base}/${project}/-/merge_requests/${iid}`
		};
		mergeRequests.push(mr);
		send(res, 201, mr);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		apiUrl: `${base}/api/v4`,
		mergeRequests,
		notes,
		setState(project, iid, state) {
			const mr = mergeRequests.find((m) => m.project === project && m.iid === iid);
			if (mr) mr.state = state;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}
