/**
 * Pure logic for the per-session "approaching context limit" warning.
 *
 * The metric we care about is the projected size of the *next* turn's
 * prompt — that's what would fail with a context-overflow error. Per
 * Anthropic's docs, the prompt the model just processed has size
 *   total_input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * (`input_tokens` alone is *only* the slice after the last cache breakpoint,
 * which Claude Code aggressively caches against — it is typically tiny
 * even when the actual conversation is huge). The next turn will include
 * all of that PLUS the assistant's `output_tokens` rolled into history,
 * before any new user input. Summing those four fields gives a faithful
 * "floor" for next-turn size, which is what we threshold against.
 *
 * One-shot semantics (per session): we only nag once. If the user changes
 * the threshold, the notice re-arms — same approach as the cost-guard warn.
 */

import type { UsageInfo } from "../types";

/**
 * Project the size of the next turn's prompt from the usage of a completed
 * turn. See module docstring for the rationale on summing all four fields.
 */
export function projectedContextSize(usage: UsageInfo | undefined): number {
	if (!usage) return 0;
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.output_tokens ?? 0)
	);
}

export interface ContextWarnState {
	/** The threshold (input tokens) at which we last warned. Re-arms if changed. */
	warnedAtThreshold: number | null;
}

export function freshContextWarnState(): ContextWarnState {
	return { warnedAtThreshold: null };
}

export type ContextWarnCheck =
	| { kind: "ok" }
	| { kind: "warn"; usedTokens: number; thresholdTokens: number; percent: number };

/**
 * Decide whether the next user-facing notice should fire given the projected
 * size of the next turn (typically `projectedContextSize(usage)`).
 *
 * - `modelContextSize` of 0 disables the check entirely.
 * - `warnPercent` outside (0, 100) disables the check.
 * - The threshold itself is `modelContextSize * warnPercent / 100`. State
 *   is keyed on the threshold so changing either input re-arms the notice.
 */
export function checkContextWarn(
	projectedTokens: number,
	modelContextSize: number,
	warnPercent: number,
	state: ContextWarnState,
): ContextWarnCheck {
	if (modelContextSize <= 0) return { kind: "ok" };
	if (warnPercent <= 0 || warnPercent >= 100) return { kind: "ok" };
	const threshold = Math.floor((modelContextSize * warnPercent) / 100);
	if (projectedTokens < threshold) return { kind: "ok" };
	if (state.warnedAtThreshold === threshold) return { kind: "ok" };
	return {
		kind: "warn",
		usedTokens: projectedTokens,
		thresholdTokens: threshold,
		percent: warnPercent,
	};
}

/** Mark the most recent threshold as delivered so it doesn't re-fire. */
export function markContextWarnDelivered(state: ContextWarnState, thresholdTokens: number): void {
	state.warnedAtThreshold = thresholdTokens;
}
