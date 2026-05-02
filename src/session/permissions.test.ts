import { describe, expect, it } from "vitest";
import { applyDecision, emptyGrants } from "./permissions";
import { PermissionGrants } from "../types";

function grants(allowed: string[] = [], denied: string[] = []): PermissionGrants {
	return { allowedTools: [...allowed], deniedTools: [...denied] };
}

describe("emptyGrants", () => {
	it("seeds allowedTools from input and starts deniedTools empty", () => {
		const g = emptyGrants(["Read", "Grep"]);
		expect(g.allowedTools).toEqual(["Read", "Grep"]);
		expect(g.deniedTools).toEqual([]);
	});

	it("returns a copy of the input array (no aliasing)", () => {
		const src = ["Read"];
		const g = emptyGrants(src);
		src.push("Edit");
		expect(g.allowedTools).toEqual(["Read"]);
	});
});

describe("applyDecision", () => {
	it("'deny' adds to deniedTools and removes from allowedTools", () => {
		const out = applyDecision(grants(["Edit"]), "Edit", "deny");
		expect(out.deniedTools).toEqual(["Edit"]);
		expect(out.allowedTools).toEqual([]);
	});

	it("'once' / 'session' / 'global' add to allowedTools and remove from deniedTools", () => {
		for (const decision of ["once", "session", "global"] as const) {
			const out = applyDecision(grants([], ["Edit"]), "Edit", decision);
			expect(out.allowedTools).toEqual(["Edit"]);
			expect(out.deniedTools).toEqual([]);
		}
	});

	it("does not duplicate when allowing an already-allowed tool", () => {
		const out = applyDecision(grants(["Read"]), "Read", "session");
		expect(out.allowedTools).toEqual(["Read"]);
	});

	it("does not duplicate when denying an already-denied tool", () => {
		const out = applyDecision(grants([], ["Bash"]), "Bash", "deny");
		expect(out.deniedTools).toEqual(["Bash"]);
	});

	it("toggling deny → allow → deny ends in a deniedTools entry", () => {
		const a = applyDecision(grants(), "Edit", "deny");
		const b = applyDecision(a, "Edit", "session");
		const c = applyDecision(b, "Edit", "deny");
		expect(c.deniedTools).toEqual(["Edit"]);
		expect(c.allowedTools).toEqual([]);
	});

	it("returns a new object (does not mutate input)", () => {
		const before = grants(["Edit"]);
		const out = applyDecision(before, "Edit", "deny");
		expect(out).not.toBe(before);
		expect(out.allowedTools).not.toBe(before.allowedTools);
		expect(out.deniedTools).not.toBe(before.deniedTools);
		expect(before.allowedTools).toEqual(["Edit"]);
		expect(before.deniedTools).toEqual([]);
	});

	it("preserves lastAttached", () => {
		const before = grants(["Edit"]);
		before.lastAttached = { path: "n.md", contentHash: "h", kind: "note" };
		const out = applyDecision(before, "Bash", "session");
		expect(out.lastAttached).toBe(before.lastAttached);
	});

	it("idempotent: applying the same decision twice produces equal output", () => {
		const a = applyDecision(grants([], ["Edit"]), "Edit", "session");
		const b = applyDecision(a, "Edit", "session");
		expect(b).toEqual(a);
	});
});
