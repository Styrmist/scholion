import { beforeEach, describe, expect, it } from "vitest";
import {
	checkContextWarn,
	ContextWarnState,
	freshContextWarnState,
	markContextWarnDelivered,
	projectedContextSize,
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

describe("projectedContextSize", () => {
	it("returns 0 for undefined usage", () => {
		expect(projectedContextSize(undefined)).toBe(0);
	});

	it("returns 0 for an empty usage object (all fields undefined)", () => {
		expect(projectedContextSize({})).toBe(0);
	});

	it("sums input + cache_read + cache_creation + output", () => {
		expect(
			projectedContextSize({
				input_tokens: 50,
				cache_read_input_tokens: 100_000,
				cache_creation_input_tokens: 1_000,
				output_tokens: 2_500,
			}),
		).toBe(50 + 100_000 + 1_000 + 2_500);
	});

	it("treats missing fields as 0 — partial usage object is fine", () => {
		expect(projectedContextSize({ input_tokens: 10, output_tokens: 20 })).toBe(30);
	});

	it("models the docs example: 100k cached + 50 post-breakpoint = 100050", () => {
		// Per Anthropic prompt-caching docs: total_input_tokens for a request
		// with 100k cache reads, 0 creation, and 50 post-breakpoint input is
		// 100050. We then add output_tokens to get the projected next-turn size.
		expect(
			projectedContextSize({
				input_tokens: 50,
				cache_read_input_tokens: 100_000,
				cache_creation_input_tokens: 0,
				output_tokens: 0,
			}),
		).toBe(100_050);
	});
});
