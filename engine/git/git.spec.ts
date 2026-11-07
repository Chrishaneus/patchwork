import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from './git';

describe('parseRemoteUrl', () => {
	it.each([
		['git@github.com:acme/widgets.git', 'github', 'acme/widgets'],
		['https://github.com/acme/widgets', 'github', 'acme/widgets'],
		['https://github.com/acme/widgets.git/', 'github', 'acme/widgets'],
		['ssh://git@github.com/acme/widgets.git', 'github', 'acme/widgets'],
		['https://gitlab.com/group/sub/app.git', 'gitlab', 'group/sub/app'],
		['git@bitbucket.org:team/repo.git', 'bitbucket', 'team/repo'],
		['https://git.example.com/team/repo.git', 'other', 'team/repo']
	])('parses %s', (url, provider, slug) => {
		expect(parseRemoteUrl(url)).toMatchObject({ provider, slug });
	});

	it('returns no slug for local paths', () => {
		expect(parseRemoteUrl('/srv/git/repo.git').slug).toBeNull();
	});
});
