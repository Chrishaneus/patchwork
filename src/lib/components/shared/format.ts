import { getLocale } from '#lib/paraglide/runtime.js';

const units: [Intl.RelativeTimeFormatUnit, number][] = [
	['day', 86_400_000],
	['hour', 3_600_000],
	['minute', 60_000]
];

/** "5 minutes ago" in the current language. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
	const diff = new Date(iso).getTime() - now;
	const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
	for (const [unit, ms] of units) {
		if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
	}
	return rtf.format(0, 'minute');
}

export function formatCost(usd: number): string {
	return new Intl.NumberFormat(getLocale(), {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: usd < 1 ? 3 : 2
	}).format(usd);
}

export interface DiffFile {
	path: string;
	lines: string[];
}

/** Split a unified diff into files, keeping the hunk lines for display. */
export function splitDiff(patch: string): DiffFile[] {
	return patch
		.split(/^diff --git /m)
		.filter(Boolean)
		.map((chunk) => {
			const [header, ...rest] = chunk.split('\n');
			const match = / b\/(.+)$/.exec(header);
			const body = rest.slice(rest.findIndex((l) => l.startsWith('@@') || l.startsWith('Binary')));
			return { path: match?.[1] ?? header, lines: body.filter((l, i) => l || i < body.length - 1) };
		});
}
