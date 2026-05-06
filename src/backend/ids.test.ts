import { describe, expect, it } from "vitest";
import { sessionId, turnId, permReqId } from "./ids";

describe("branded ids", () => {
	it("wraps a string as SessionId without altering its runtime value", () => {
		const id = sessionId("abc");
		expect(id).toBe("abc");
	});

	it("wraps TurnId and PermReqId likewise", () => {
		expect(turnId("t1")).toBe("t1");
		expect(permReqId("p1")).toBe("p1");
	});

	it("brands are distinct at the type level (compile check)", () => {
		const s = sessionId("a");
		const t = turnId("a");
		const p = permReqId("a");
		expect(s).toBe(t);
		expect(t).toBe(p);
	});
});
