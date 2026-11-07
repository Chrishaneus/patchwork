import { describe, expect, it } from 'vitest';
import { isSignInError } from './runner';

describe('isSignInError', () => {
	it('recognizes a missing login or bad key', () => {
		expect(isSignInError('Not logged in · Please run /login')).toBe(true);
		expect(isSignInError('Invalid API key · Fix external API key')).toBe(true);
		expect(isSignInError('Tool failed: file not found')).toBe(false);
	});
});
