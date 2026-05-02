import { SessionUsage } from "../types";

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

export function formatUsage(u: SessionUsage): string {
	const cost = `$${u.totalCostUsd.toFixed(4)}`;
	const inTok = formatTokens(u.inputTokens);
	const outTok = formatTokens(u.outputTokens);
	return `${cost} · ${inTok} in / ${outTok} out`;
}
