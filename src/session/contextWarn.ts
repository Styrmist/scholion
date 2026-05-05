/**
 * Pure logic for the per-session "approaching context limit" warning.
 *
 * The CLI emits `usage.input_tokens` on every `result` event — that's the
 * size of the prompt the model just processed, which is approximately the
 * size of the conversation context. We compare it against a configured
 * model context size and a percentage threshold; once crossed we emit a
 * one-shot transcript notice so the user can `/compact` or fork before
 * the context window fills.
 *
 * One-shot semantics (per session): we only nag once. If the user changes
 * the threshold, the notice re-arms — same approach as the cost-guard warn.
 */

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
 * Decide whether the next user-facing notice should fire given the most
 * recent turn's usage.
 *
 * - `modelContextSize` of 0 disables the check entirely.
 * - `warnPercent` outside (0, 100) disables the check.
 * - The threshold itself is `modelContextSize * warnPercent / 100`. State
 *   is keyed on the threshold so changing either input re-arms the notice.
 */
export function checkContextWarn(
	lastTurnInputTokens: number,
	modelContextSize: number,
	warnPercent: number,
	state: ContextWarnState,
): ContextWarnCheck {
	if (modelContextSize <= 0) return { kind: "ok" };
	if (warnPercent <= 0 || warnPercent >= 100) return { kind: "ok" };
	const threshold = Math.floor((modelContextSize * warnPercent) / 100);
	if (lastTurnInputTokens < threshold) return { kind: "ok" };
	if (state.warnedAtThreshold === threshold) return { kind: "ok" };
	return {
		kind: "warn",
		usedTokens: lastTurnInputTokens,
		thresholdTokens: threshold,
		percent: warnPercent,
	};
}

/** Mark the most recent threshold as delivered so it doesn't re-fire. */
export function markContextWarnDelivered(state: ContextWarnState, thresholdTokens: number): void {
	state.warnedAtThreshold = thresholdTokens;
}
