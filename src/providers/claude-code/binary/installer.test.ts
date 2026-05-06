import { describe, expect, it } from "vitest";
import { shouldRemoveStalePreviousBinary } from "./installer";
import { STALE_PREVIOUS_BINARY_AGE_MS } from "../../../constants";

describe("shouldRemoveStalePreviousBinary", () => {
	it("returns false when age is null (stat failed / file vanished)", () => {
		expect(shouldRemoveStalePreviousBinary(null, STALE_PREVIOUS_BINARY_AGE_MS)).toBe(false);
	});

	it("returns false for a fresh file (age below threshold)", () => {
		expect(shouldRemoveStalePreviousBinary(60_000, STALE_PREVIOUS_BINARY_AGE_MS)).toBe(false);
	});

	it("returns false at exactly the threshold (strict greater-than)", () => {
		expect(shouldRemoveStalePreviousBinary(STALE_PREVIOUS_BINARY_AGE_MS, STALE_PREVIOUS_BINARY_AGE_MS)).toBe(false);
	});

	it("returns true once age exceeds the threshold", () => {
		expect(shouldRemoveStalePreviousBinary(STALE_PREVIOUS_BINARY_AGE_MS + 1, STALE_PREVIOUS_BINARY_AGE_MS)).toBe(true);
		expect(shouldRemoveStalePreviousBinary(STALE_PREVIOUS_BINARY_AGE_MS * 7, STALE_PREVIOUS_BINARY_AGE_MS)).toBe(true);
	});

	it("threshold is 24h to give an in-flight install plenty of room before we sweep", () => {
		expect(STALE_PREVIOUS_BINARY_AGE_MS).toBe(24 * 60 * 60 * 1000);
	});
});
