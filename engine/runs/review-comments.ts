import type { ReviewComment } from '#lib/engine/contract.js';
import { tryGit } from '../git/git.js';

/**
 * The lines of each file that a diff shows on its new side, hunk by hunk: what GitHub and
 * GitLab let you comment on inline. With git's usual 3 lines of context, like theirs.
 */
export function changedLines(patch: string): Map<string, [number, number][]> {
	const files = new Map<string, [number, number][]>();
	let current: [number, number][] | null = null;
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++ ')) {
			const target = line.slice(4).trim();
			current = target === '/dev/null' ? null : [];
			if (current) files.set(target.replace(/^b\//, ''), current);
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && current) {
			const start = Number(hunk[1]);
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			if (count > 0) current.push([start, start + count - 1]);
		}
	}
	return files;
}

/** Whether lines `from`–`to` lie within one hunk of the file. */
export function inHunk(ranges: [number, number][] | undefined, from: number, to: number) {
	return !!ranges?.some(([start, end]) => from >= start && to <= end);
}

/**
 * Fill in each comment's original lines (from the reviewed commit) and whether they're in the
 * pull request's diff. A comment on a missing file or past its end keeps `original` null and
 * can't go inline.
 */
export async function anchorComments(
	dir: string,
	baseCommit: string,
	head: string,
	comments: ReviewComment[]
): Promise<ReviewComment[]> {
	if (comments.length === 0) return comments;
	// Only the commented files, so a large pull request's diff stays small.
	const paths = [...new Set(comments.map((c) => c.path))];
	const patch =
		(await tryGit(
			dir,
			['diff', '--no-color', '--no-ext-diff', '-U3', baseCommit, head, '--', ...paths],
			{ trim: false }
		)) ?? '';
	const changed = changedLines(patch);
	const files = new Map<string, string[] | null>();
	const read = async (path: string) => {
		if (!files.has(path)) {
			const text = await tryGit(dir, ['show', `${head}:${path}`], { trim: false });
			files.set(path, text === null ? null : text.replace(/\n$/, '').split('\n'));
		}
		return files.get(path)!;
	};
	const anchored: ReviewComment[] = [];
	for (const comment of comments) {
		const fileLines = await read(comment.path);
		const fits = !!fileLines && comment.line <= fileLines.length;
		anchored.push({
			...comment,
			original: fits ? fileLines!.slice(comment.startLine - 1, comment.line).join('\n') : null,
			inDiff: fits && inHunk(changed.get(comment.path), comment.startLine, comment.line)
		});
	}
	return anchored;
}
