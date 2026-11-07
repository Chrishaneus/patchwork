import { describe, expect, it, vi } from 'vitest';
import { createEngineClient } from './client';
import { EngineError } from './contract';

describe('createEngineClient', () => {
	it('sends the method and input through the transport and returns the value', async () => {
		const transport = vi.fn().mockResolvedValue({ ok: true, value: [] });
		const client = createEngineClient(transport);

		await expect(client.listRepositories({})).resolves.toEqual([]);
		expect(transport).toHaveBeenCalledWith('listRepositories', {});
	});

	it('turns failed results into EngineError with the same code', async () => {
		const transport = vi
			.fn()
			.mockResolvedValue({ ok: false, error: { code: 'no_remote', message: 'no remote' } });
		const client = createEngineClient(transport);

		const error = await client.addRepository({ path: '/x' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EngineError);
		expect(error).toMatchObject({ code: 'no_remote' });
	});
});
