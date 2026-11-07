import { describe, expect, it } from 'vitest';
import { detectAgentMode, findPullRequestLink, parseAgentMode } from './agent-mode';

describe('agent mode', () => {
	it('reads the mode from the link, defaulting to a change', () => {
		expect(parseAgentMode('review')).toBe('review');
		expect(parseAgentMode('explore')).toBe('explore');
		expect(parseAgentMode('nope')).toBe('change');
		expect(parseAgentMode(null)).toBe('change');
	});

	it('finds pull request and merge request links in a message', () => {
		expect(
			findPullRequestLink('please look at https://github.com/acme/api/pull/12/files thanks')
		).toBe('https://github.com/acme/api/pull/12');
		expect(findPullRequestLink('https://gitlab.com/g/sub/proj/-/merge_requests/7')).toBe(
			'https://gitlab.com/g/sub/proj/-/merge_requests/7'
		);
		expect(findPullRequestLink('Upgrade https://github.com/acme/api to v2')).toBeNull();
	});

	it.each([
		['review https://github.com/acme/api/pull/12', 'review'],
		['https://gitlab.com/g/p/-/merge_requests/3 focus on errors', 'review'],
		['Can you check PR #14 for security issues?', 'review'],
		['please look at this pull request', 'review'],
		['explore adding a cache to search', 'explore'],
		['How should we add rate limiting?', 'explore'],
		['What are the options for storing sessions', 'explore'],
		['compare Redis and Postgres for the job queue', 'explore'],
		['can you explain what checkhate is', 'ask'],
		['What does the sync job do?', 'ask'],
		['How does sign-in work', 'ask'],
		['Is there a test for the parser?', 'ask'],
		['Explain the build setup', 'ask'],
		['Add a changelog', 'change'],
		['Upgrade eslint and fix the new lint errors', 'change'],
		['Check the README for typos and fix them', 'change'],
		['', 'change']
	])('detects %j as %s', (text, mode) => {
		expect(detectAgentMode(text)).toBe(mode);
	});
});
