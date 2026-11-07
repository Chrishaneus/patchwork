import { describe, expect, it } from 'vitest';
import { splitDiff } from './format';

describe('splitDiff', () => {
	it('splits a unified diff into files with their hunk lines', () => {
		const patch = [
			'diff --git a/README.md b/README.md',
			'index 1..2 100644',
			'--- a/README.md',
			'+++ b/README.md',
			'@@ -1 +1,2 @@',
			' # test',
			'+More',
			'diff --git a/new.txt b/new.txt',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/new.txt',
			'@@ -0,0 +1 @@',
			'+hello',
			''
		].join('\n');

		expect(splitDiff(patch)).toEqual([
			{ path: 'README.md', lines: ['@@ -1 +1,2 @@', ' # test', '+More'] },
			{ path: 'new.txt', lines: ['@@ -0,0 +1 @@', '+hello'] }
		]);
	});

	it('returns nothing for an empty patch', () => {
		expect(splitDiff('')).toEqual([]);
	});
});
