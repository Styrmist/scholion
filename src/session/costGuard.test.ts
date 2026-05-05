import { beforeEach, describe, expect, it } from "vitest";
import {
	checkCostGuard,
	CostGuardState,
	freshCostGuardState,
	markCapBypassed,
	markWarnDelivered,
} from "./costGuard";

describe("checkCostGuard", () => {
	let state: CostGuardState;

	beforeEach(() => {
		state = freshCostGuardState();
	});

	it("returns ok when both thresholds are 0 (disabled)", () => {
		expect(checkCostGuard(100, 0, 0, state)).toEqual({ kind: "ok" });
	});

	it("returns ok below both thresholds", () => {
		expect(checkCostGuard(0.5, 1, 5, state)).toEqual({ kind: "ok" });
	});

	it("warns when cost >= warn threshold", () => {
		expect(checkCostGuard(1.0, 1, 5, state)).toEqual({
			kind: "warn",
			cost: 1.0,
			threshold: 1,
		});
	});

	it("does not re-warn for the same threshold once delivered", () => {
		const first = checkCostGuard(1.0, 1, 5, state);
		expect(first.kind).toBe("warn");
		markWarnDelivered(state, 1);
		expect(checkCostGuard(2.0, 1, 5, state)).toEqual({ kind: "ok" });
	});

	it("re-arms the warn when the threshold value changes (lowered/raised)", () => {
		markWarnDelivered(state, 1);
		// Threshold lowered from 1 to 0.5 — the new threshold has not been delivered.
		expect(checkCostGuard(0.7, 0.5, 5, state)).toEqual({
			kind: "warn",
			cost: 0.7,
			threshold: 0.5,
		});
	});

	it("blocks at the hard cap", () => {
		expect(checkCostGuard(5.0, 1, 5, state)).toEqual({
			kind: "block",
			cost: 5.0,
			threshold: 5,
		});
	});

	it("hard cap takes precedence over warn", () => {
		// Cost is past both. Block, not warn.
		expect(checkCostGuard(10, 1, 5, state).kind).toBe("block");
	});

	it("does not block once the user has bypassed the cap for the session", () => {
		expect(checkCostGuard(5, 1, 5, state).kind).toBe("block");
		markCapBypassed(state);
		// Now blocking is suppressed; warn behavior follows its own rules.
		const next = checkCostGuard(5, 1, 5, state);
		// Warn would still fire if not yet delivered for the threshold, since
		// $5 >= warn $1. After bypass we'd typically have already warned, but
		// the function itself doesn't auto-mark — verify the contract.
		expect(next.kind === "warn" || next.kind === "ok").toBe(true);
	});

	it("warn threshold of 0 is treated as disabled even if cap fires", () => {
		expect(checkCostGuard(10, 0, 5, state).kind).toBe("block");
		markCapBypassed(state);
		expect(checkCostGuard(10, 0, 5, state)).toEqual({ kind: "ok" });
	});

	it("hard cap threshold of 0 is treated as disabled (warn still fires)", () => {
		expect(checkCostGuard(2, 1, 0, state)).toEqual({
			kind: "warn",
			cost: 2,
			threshold: 1,
		});
	});

	it("bypass flag does not implicitly warn for thresholds the user passed long ago", () => {
		// Establish bypassed state and a delivered warn at threshold 1.
		markWarnDelivered(state, 1);
		markCapBypassed(state);
		expect(checkCostGuard(20, 1, 5, state)).toEqual({ kind: "ok" });
	});
});

describe("freshCostGuardState", () => {
	it("returns null/false defaults", () => {
		expect(freshCostGuardState()).toEqual({ warnedAtThreshold: null, capBypassed: false });
	});
});
