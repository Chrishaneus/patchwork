import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Markdown from './Markdown.svelte';

// The answer from the "what is checkhate" question, shortened.
const answer = `It's an **online judge**: a competitive-programming style platform.

## Components

| Path | Role |
|---|---|
| \`api/\` | Flask API at \`/api/v1\` |
| \`runner/\` | Go program that runs each test in a sandbox |

## How a submission is judged
1. \`POST /api/v1/submissions\` saves the submission as \`PENDING\`.
2. A free runner picks up the job.

\`\`\`python
print("hello")
\`\`\``;

describe('Markdown.svelte', () => {
	it('renders headings, tables, lists, inline code and code blocks', async () => {
		render(Markdown, { text: answer });
		await expect.element(page.getByRole('heading', { name: 'Components' })).toBeInTheDocument();
		await expect.element(page.getByRole('table')).toBeInTheDocument();
		await expect.element(page.getByRole('cell', { name: 'runner/' })).toBeInTheDocument();
		await expect
			.element(page.getByRole('listitem').first())
			.toHaveTextContent('POST /api/v1/submissions saves the submission as PENDING.');
		await expect.element(page.getByText('online judge')).toHaveProperty('tagName', 'STRONG');
		await expect.element(page.getByText('print("hello")', { exact: false })).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('## Components');
		expect(document.body.textContent).not.toContain('|---|');
	});

	it('shows raw HTML as text and blocks script links', async () => {
		const { container } = render(Markdown, {
			text: '<img src=x onerror="window.pwned = 1"> [bad](javascript:alert(1)) [docs](https://example.com)'
		});
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
		expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
		await expect
			.element(page.getByRole('link', { name: 'docs' }))
			.toHaveAttribute('href', 'https://example.com/');
	});
});
