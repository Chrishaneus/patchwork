import { describe, expect, it } from 'vitest';
import { decideToolUse } from './policy';

const cwd = '/data/worktrees/task-1';

describe('decideToolUse', () => {
	it('allows file changes inside the worktree only', () => {
		expect(decideToolUse('Edit', { file_path: `${cwd}/src/a.ts` }, cwd).allow).toBe(true);
		expect(decideToolUse('Write', { file_path: 'src/new.ts' }, cwd).allow).toBe(true);
		expect(decideToolUse('Edit', { file_path: '/etc/hosts' }, cwd).allow).toBe(false);
		expect(decideToolUse('Write', { file_path: `${cwd}/../other/a.ts` }, cwd).allow).toBe(false);
		expect(decideToolUse('Write', { file_path: `${cwd}-evil/a.ts` }, cwd).allow).toBe(false);
	});

	it('blocks publishing commands but allows normal shell work', () => {
		for (const command of ['npm test', 'git status', 'git diff', 'git commit -m x', 'ls -la']) {
			expect(decideToolUse('Bash', { command }, cwd).allow).toBe(true);
		}
		for (const command of [
			'git push origin HEAD',
			'npm test && git push',
			'git remote set-url origin x',
			'git worktree remove .',
			'gh pr create --fill'
		]) {
			expect(decideToolUse('Bash', { command }, cwd).allow).toBe(false);
		}
	});

	it('allows read-only tools', () => {
		expect(decideToolUse('Read', { file_path: '/etc/hosts' }, cwd).allow).toBe(true);
		expect(decideToolUse('Grep', { pattern: 'x' }, cwd).allow).toBe(true);
	});
});

describe('read-only workflows', () => {
	it('refuses file changes but still allows reading and commands', () => {
		expect(decideToolUse('Edit', { file_path: `${cwd}/src/a.ts` }, cwd, true).allow).toBe(false);
		expect(decideToolUse('Write', { file_path: 'x.ts' }, cwd, true).allow).toBe(false);
		expect(decideToolUse('Read', { file_path: `${cwd}/src/a.ts` }, cwd, true).allow).toBe(true);
		expect(decideToolUse('Bash', { command: 'npm test' }, cwd, true).allow).toBe(true);
		expect(decideToolUse('Bash', { command: 'git push' }, cwd, true).allow).toBe(false);
	});
});
