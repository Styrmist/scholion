import { describe, expect, it } from "vitest";
import { canTransition, TurnStateKind } from "./turnState";

const ALL: TurnStateKind[] = [
	"idle",
	"starting",
	"streaming",
	"tool_running",
	"awaiting_permission",
	"aborting",
	"error",
];

const EXPECTED: Record<TurnStateKind, ReadonlyArray<TurnStateKind>> = {
	idle: ["starting"],
	starting: ["streaming", "tool_running", "awaiting_permission", "idle", "error"],
	streaming: ["streaming", "tool_running", "awaiting_permission", "idle", "error"],
	tool_running: ["streaming", "tool_running", "awaiting_permission", "idle", "error"],
	awaiting_permission: ["starting", "streaming", "tool_running", "idle", "aborting"],
	aborting: ["idle"],
	error: ["idle", "starting"],
};

describe("canTransition", () => {
	it.each(ALL)("table-driven: every transition from %s matches the spec", (from) => {
		const allowed = new Set(EXPECTED[from]);
		for (const to of ALL) {
			const expected = allowed.has(to);
			expect(
				canTransition(from, to),
				`expected canTransition(${from} → ${to}) to be ${expected}`,
			).toBe(expected);
		}
	});

	it("idle → starting is permitted", () => {
		expect(canTransition("idle", "starting")).toBe(true);
	});
	it("streaming → tool_running is permitted", () => {
		expect(canTransition("streaming", "tool_running")).toBe(true);
	});
	it("error → streaming is rejected", () => {
		expect(canTransition("error", "streaming")).toBe(false);
	});
	it("idle → error is rejected", () => {
		expect(canTransition("idle", "error")).toBe(false);
	});
	it("aborting can only return to idle", () => {
		for (const to of ALL) {
			expect(canTransition("aborting", to)).toBe(to === "idle");
		}
	});
});
