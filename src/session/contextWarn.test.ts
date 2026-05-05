import { beforeEach, describe, expect, it } from "vitest";
import {
	checkContextWarn,
	ContextWarnState,
	freshContextWarnState,
	markContextWarnDelivered,
} from "./contextWarn";

describe("checkContextWarn", () => {
	let state: ContextWarnState;

	beforeEach(() => {
		state = freshContextWarnState();
	});

	it("returns ok when modelContextSize is 0 (disabled)", () => {
		expect(checkContextWarn(999_999, 0, 80, state)).toEqual({ kind: "ok" });
	});

	it("returns ok when warnPercent is 0", () => {
		expect(checkContextWarn(999_999, 200_000, 0, state)).toEqual({ kind: "ok" });
	});

	it("returns ok when warnPercent is >= 100 (no slack to warn within)", () => {
		expect(checkContextWarn(999_999, 200_000, 100, state)).toEqual({ kind: "ok" });
		expect(checkContextWarn(999_999, 200_000, 150, state)).toEqual({ kind: "ok" });
	});

	it("returns ok when used tokens are below the threshold", () => {
		// 80% of 200k = 160k.
		expect(checkContextWarn(159_999, 200_000, 80, state)).toEqual({ kind: "ok" });
	});

	it("warns when used tokens cross the threshold", () => {
		const out = checkContextWarn(160_000, 200_000, 80, state);
		expect(out).toEqual({
			kind: "warn",
			usedTokens: 160_000,
			thresholdTokens: 160_000,
			percent: 80,
		});
	});

	it("does not re-warn for the same threshold once delivered", () => {
		const first = checkContextWarn(160_000, 200_000, 80, state);
		expect(first.kind).toBe("warn");
		if (first.kind === "warn") markContextWarnDelivered(state, first.thresholdTokens);
		expect(checkContextWarn(170_000, 200_000, 80, state)).toEqual({ kind: "ok" });
	});

	it("re-arms the warn when the threshold changes (model size or percent)", () => {
		markContextWarnDelivered(state, 160_000);
		// Change percent: new threshold 90% of 200k = 180k.
		const out = checkContextWarn(190_000, 200_000, 90, state);
		expect(out.kind).toBe("warn");
	});

	it("floors fractional thresholds (90.5% of 200k → 181000)", () => {
		const out = checkContextWarn(181_000, 200_000, 90.5, state);
		expect(out.kind).toBe("warn");
		if (out.kind === "warn") expect(out.thresholdTokens).toBe(181_000);
	});

	it("treats negative model size as disabled", () => {
		expect(checkContextWarn(50_000, -1, 80, state)).toEqual({ kind: "ok" });
	});
});

describe("freshContextWarnState", () => {
	it("starts with no delivered threshold", () => {
		expect(freshContextWarnState()).toEqual({ warnedAtThreshold: null });
	});
});
