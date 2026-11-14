import { afterEach, describe, expect, it } from 'vitest';
import { startFakeGitHub } from '../../dev/fake-github';
import { startFakeGitLab } from '../../dev/fake-gitlab';
import { createGitHubClient } from './github';
import { createGitLabClient } from './gitlab';
import type { InlineComment } from './index';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

const comment = (over: Partial<InlineComment> = {}): InlineComment => ({
	path: 'src/app.ts',
	startLine: 3,
	line: 4,
	body: 'Use a constant.\n\n```suggestion\nconst LIMIT = 10;\n```',
	...over
});

/** The main comment lists what couldn't go inline, so the tests can see it. */
const body = (notInline: InlineComment[]) =>
	`Review.${notInline.map((c) => ` [not inline: ${c.path}:${c.line}]`).join('')}`;

describe('GitHub reviews', () => {
	async function setup() {
		const gh = await startFakeGitHub();
		closers.push(gh.close);
		const res = await fetch(`${gh.url}/repos/acme/widgets/pulls`, {
			method: 'POST',
			headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Change', head: 'feature', base: 'main' })
		});
		expect(res.status).toBe(201);
		return { gh, client: createGitHubClient({ apiUrl: gh.url, token: 'x' }) };
	}

	it('posts comments on lines, anchored to the reviewed commit', async () => {
		const { gh, client } = await setup();
		const posted = await client.review('acme/widgets', 1, {
			headSha: 'abc123',
			comments: [comment(), comment({ startLine: 9, line: 9, body: 'One line.' })],
			body
		});
		expect(posted.notInline).toEqual([]);
		expect(posted.url).toContain('#pullrequestreview-1');
		expect(gh.reviews[0]).toMatchObject({
			event: 'COMMENT',
			commit_id: 'abc123',
			body: 'Review.',
			comments: [
				{ path: 'src/app.ts', start_line: 3, line: 4, side: 'RIGHT' },
				{ path: 'src/app.ts', line: 9, body: 'One line.' }
			]
		});
		expect(gh.reviews[0].comments[1]).not.toHaveProperty('start_line');
	});

	it('puts the comments in the main comment when GitHub refuses them on their lines', async () => {
		const { gh, client } = await setup();
		const bad = comment({ line: 0 });
		const posted = await client.review('acme/widgets', 1, {
			headSha: null,
			comments: [bad],
			body
		});
		expect(posted.notInline).toEqual([bad]);
		expect(gh.reviews).toHaveLength(1);
		expect(gh.reviews[0]).toMatchObject({
			body: 'Review. [not inline: src/app.ts:0]',
			comments: []
		});
	});
});

describe('GitLab reviews', () => {
	async function setup(headSha: string) {
		const gl = await startFakeGitLab();
		closers.push(gl.close);
		gl.mergeRequests.push({
			project: 'acme/api',
			iid: 4,
			title: 'Change',
			description: '',
			source_branch: 'feature',
			target_branch: 'main',
			state: 'opened',
			draft: false,
			web_url: 'http://gitlab.test/acme/api/-/merge_requests/4',
			diff_refs: { base_sha: 'b', start_sha: 's', head_sha: headSha }
		});
		return { gl, client: createGitLabClient({ apiUrl: gl.apiUrl, token: 'x' }) };
	}

	it('starts a discussion on each line, then posts the main note', async () => {
		const { gl, client } = await setup('h1');
		const posted = await client.review('acme/api', 4, {
			headSha: 'h1',
			comments: [comment()],
			body
		});
		expect(posted.notInline).toEqual([]);
		expect(gl.discussions).toMatchObject([
			{
				iid: 4,
				body: comment().body,
				position: { new_path: 'src/app.ts', new_line: 4, head_sha: 'h1' }
			}
		]);
		expect(gl.notes).toMatchObject([{ iid: 4, body: 'Review.' }]);
		expect(posted.url).toBe('http://gitlab.test/acme/api/-/merge_requests/4#note_1');
	});

	it('keeps comments off their lines when the merge request moved on since the review', async () => {
		const { gl, client } = await setup('h2');
		const posted = await client.review('acme/api', 4, {
			headSha: 'h1',
			comments: [comment()],
			body
		});
		expect(posted.notInline).toHaveLength(1);
		expect(gl.discussions).toEqual([]);
		expect(gl.notes[0].body).toBe('Review. [not inline: src/app.ts:4]');
	});
});
