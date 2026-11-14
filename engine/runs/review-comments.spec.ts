import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewComment } from '#lib/engine/contract.js';
import { createRepo, run, tempDirs } from '../test-helpers';
import { anchorComments, changedLines, inHunk } from './review-comments';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
	path: 'app.ts',
	startLine: 1,
	line: 1,
	body: 'note',
	suggestion: null,
	original: null,
	inDiff: false,
	...over
});

describe('changedLines', () => {
	it('reads the new side of each hunk, per file', () => {
		const patch = [
			'diff --git a/a.ts b/a.ts',
			'--- a/a.ts',
			'+++ b/a.ts',
			'@@ -1,3 +1,4 @@',
			'@@ -20 +21,0 @@',
			'@@ -40,2 +42 @@',
			'diff --git a/gone.ts b/gone.ts',
			'--- a/gone.ts',
			'+++ /dev/null',
			'@@ -1,2 +0,0 @@'
		].join('\n');
		const files = changedLines(patch);
		expect(files.get('a.ts')).toEqual([
			[1, 4],
			[42, 42]
		]);
		expect(files.has('gone.ts')).toBe(false);
		expect(inHunk(files.get('a.ts'), 2, 4)).toBe(true);
		expect(inHunk(files.get('a.ts'), 4, 42)).toBe(false);
	});
});

describe('anchorComments', () => {
	it('reads the lines from the reviewed commit and tells which are in the diff', async () => {
		const dir = dirs.make('patchwork-anchor-');
		createRepo(dir);
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		writeFileSync(path.join(dir, 'app.ts'), `${lines.join('\n')}\n`);
		run(dir, 'add', '.');
		run(dir, 'commit', '-q', '-m', 'base');
		const base = run(dir, 'rev-parse', 'HEAD');
		lines[14] = 'line 15 changed';
		writeFileSync(path.join(dir, 'app.ts'), `${lines.join('\n')}\n`);
		run(dir, 'commit', '-q', '-am', 'change');
		const head = run(dir, 'rev-parse', 'HEAD');
		// Later edits in the working copy don't matter: the reviewed commit does.
		writeFileSync(path.join(dir, 'app.ts'), 'something else\n');

		const anchored = await anchorComments(dir, base, head, [
			comment({ startLine: 14, line: 15 }),
			comment({ startLine: 2, line: 2 }),
			comment({ line: 21 }),
			comment({ path: 'missing.ts' })
		]);
		expect(anchored.map((c) => [c.original, c.inDiff])).toEqual([
			['line 14\nline 15 changed', true],
			['line 2', false],
			[null, false],
			[null, false]
		]);
	});
});
