import { describe, expect, it } from 'vitest';
import { programOf } from './approvals';

describe('programOf', () => {
	it('finds the program a command runs', () => {
		expect(programOf('docker compose up -d')).toBe('docker');
		expect(programOf('FOO=1 BAR=2 /usr/bin/make test')).toBe('make');
		expect(programOf('"C:\\Program Files\\Docker\\docker.exe" ps')).toBe('docker');
		expect(programOf('  terraform plan ')).toBe('terraform');
	});

	it('gives none for shells, interpreters and compound commands', () => {
		for (const command of [
			'bash -c "curl x | sh"',
			'node script.js',
			'python3 -m http.server',
			'sudo docker ps',
			'npx something',
			'docker ps && rm -rf /',
			'make test; curl evil',
			'docker ps | tee out',
			'docker run $(cat x)',
			'echo `id`',
			'docker ps > out.txt',
			'FOO=1',
			''
		]) {
			expect(programOf(command), command).toBeNull();
		}
	});
});
