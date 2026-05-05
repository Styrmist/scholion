/**
 * Pure logic for the per-session cost guard. Two thresholds: a soft warn that
 * surfaces an in-transcript notice once, and a hard cap that blocks the next
 * turn until the user explicitly bypasses for the session.
 *
 * The cost is observed only at turn boundaries (the CLI emits totalCostUsd in
 * its terminal `result` event), so all checks fire from `handleSubmit` before
 * starting the next turn.
 */

export interface CostGuardState {
	/**
	 * The warn threshold at which we last emitted a one-shot notice. We compare
	 * the threshold (not the cost) so that lowering the warn threshold in
	 * settings re-arms the warning, while keeping the threshold the same does
	 * not produce duplicate notices on every send.
	 */
	warnedAtThreshold: number | null;
	/** Set to true after the user explicitly bypasses the hard cap for this session. */
	capBypassed: boolean;
}

export function freshCostGuardState(): CostGuardState {
	return { warnedAtThreshold: null, capBypassed: false };
}

export type CostGuardCheck =
	| { kind: "ok" }
	| { kind: "warn"; cost: number; threshold: number }
	| { kind: "block"; cost: number; threshold: number };

/**
 * Decide what should happen on the next turn given accumulated cost and the
 * configured thresholds.
 *
 * - Hard cap takes precedence: once exceeded and not bypassed, we always block.
 * - Warn fires at most once per (state, threshold) pair.
 * - 0 disables the corresponding threshold.
 */
export function checkCostGuard(
	costUsd: number,
	warnThreshold: number,
	capThreshold: number,
	state: CostGuardState,
): CostGuardCheck {
	if (capThreshold > 0 && costUsd >= capThreshold && !state.capBypassed) {
		return { kind: "block", cost: costUsd, threshold: capThreshold };
	}
	if (
		warnThreshold > 0 &&
		costUsd >= warnThreshold &&
		state.warnedAtThreshold !== warnThreshold
	) {
		return { kind: "warn", cost: costUsd, threshold: warnThreshold };
	}
	return { kind: "ok" };
}

/** Mark a warn as delivered for the current threshold. Mutates state in place. */
export function markWarnDelivered(state: CostGuardState, threshold: number): void {
	state.warnedAtThreshold = threshold;
}

/** User confirmed the cap bypass for this session. Mutates state in place. */
export function markCapBypassed(state: CostGuardState): void {
	state.capBypassed = true;
}
