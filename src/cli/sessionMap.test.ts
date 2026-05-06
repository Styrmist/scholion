import { describe, expect, it } from "vitest";
import { ClaudeSessionMap } from "./sessionMap";
import { sessionId } from "../backend/ids";

describe("ClaudeSessionMap", () => {
	it("has() and get() return false/undefined for unknown ids", () => {
		const m = new ClaudeSessionMap();
		expect(m.has(sessionId("absent"))).toBe(false);
		expect(m.get(sessionId("absent"))).toBeUndefined();
	});

	it("upsert creates a context with sensible defaults", () => {
		const m = new ClaudeSessionMap();
		m.upsert(sessionId("a"), { cwd: "/repo", model: "sonnet" });
		const ctx = m.get(sessionId("a"));
		expect(ctx).toMatchObject({
			cwd: "/repo",
			model: "sonnet",
			permissionMode: "default",
		});
	});

	it("upsert merges patches without dropping prior fields", () => {
		const m = new ClaudeSessionMap();
		m.upsert(sessionId("a"), { cwd: "/repo", model: "sonnet" });
		m.upsert(sessionId("a"), { nativeId: "claude-uuid" });
		expect(m.get(sessionId("a"))).toMatchObject({
			cwd: "/repo",
			model: "sonnet",
			nativeId: "claude-uuid",
			permissionMode: "default",
		});
	});

	it("hasNativeId reflects whether system_init has been observed", () => {
		const m = new ClaudeSessionMap();
		m.upsert(sessionId("a"), { cwd: "/repo" });
		expect(m.hasNativeId(sessionId("a"))).toBe(false);
		m.upsert(sessionId("a"), { nativeId: "claude-uuid" });
		expect(m.hasNativeId(sessionId("a"))).toBe(true);
	});

	it("multiple sessions stay isolated", () => {
		const m = new ClaudeSessionMap();
		m.upsert(sessionId("a"), { nativeId: "id-a", cwd: "/a" });
		m.upsert(sessionId("b"), { nativeId: "id-b", cwd: "/b" });
		expect(m.get(sessionId("a"))?.nativeId).toBe("id-a");
		expect(m.get(sessionId("b"))?.nativeId).toBe("id-b");
	});

	it("delete removes a context", () => {
		const m = new ClaudeSessionMap();
		m.upsert(sessionId("a"), { cwd: "/x" });
		m.delete(sessionId("a"));
		expect(m.has(sessionId("a"))).toBe(false);
	});
});
