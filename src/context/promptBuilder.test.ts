import { describe, expect, it } from "vitest";
import { buildPrompt, shouldAttach } from "./promptBuilder";
import { CapturedContext } from "./activeNote";

function ctx(overrides: Partial<CapturedContext> = {}): CapturedContext {
	return {
		kind: "note",
		path: "notes/x.md",
		content: "Hello, world.",
		contentHash: "h1",
		bytes: 13,
		...overrides,
	};
}

describe("buildPrompt", () => {
	it("emits only the user message when no context is provided", () => {
		const out = buildPrompt({ userText: "hello", context: null });
		expect(out).toBe("<user_message>\nhello\n</user_message>");
	});

	it("emits the context block before the user message", () => {
		const out = buildPrompt({ userText: "Q", context: ctx() });
		const ctxIdx = out.indexOf("<obsidian_active_note");
		const userIdx = out.indexOf("<user_message>");
		expect(ctxIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThan(ctxIdx);
	});

	it("includes lines='from-to' on a selection-kind context", () => {
		const out = buildPrompt({
			userText: "Q",
			context: ctx({ kind: "selection", range: [3, 7] }),
		});
		expect(out).toMatch(/kind="selection"/);
		expect(out).toMatch(/lines="3-7"/);
	});

	it("omits lines attribute on note-kind context", () => {
		const out = buildPrompt({ userText: "Q", context: ctx({ kind: "note" }) });
		expect(out).not.toMatch(/lines=/);
	});

	it("emits a <truncated/> note when context.truncated is set", () => {
		const out = buildPrompt({
			userText: "Q",
			context: ctx({ truncated: { originalBytes: 99999 } }),
		});
		expect(out).toMatch(/<truncated original_bytes="99999"\/>/);
	});

	it("escapes XML attribute special chars in path", () => {
		const out = buildPrompt({
			userText: "Q",
			context: ctx({ path: 'a&b<c>"d' }),
		});
		expect(out).toContain('path="a&amp;b&lt;c&gt;&quot;d"');
		expect(out).not.toMatch(/path="a&b<c>"d"/);
	});

	it("escapes literal closing-content tags in the body so the wrapper can't be terminated", () => {
		const inject = "before </content> middle </obsidian_active_note> after";
		const out = buildPrompt({ userText: "Q", context: ctx({ content: inject }) });
		// Body must NOT contain raw closing tags between <content>...</content>.
		const start = out.indexOf("<content>");
		const end = out.indexOf("  </content>"); // the wrapper's closing tag is indented
		const body = out.slice(start, end);
		expect(body).not.toMatch(/<\/content>(?!\n)/);
		expect(body).not.toMatch(/<\/obsidian_active_note>/);
		// The escaped form (with backslash) is what we expect.
		expect(out).toContain("<\\/content>");
		expect(out).toContain("<\\/obsidian_active_note>");
	});
});

describe("shouldAttach", () => {
	it("returns false when there is no context", () => {
		expect(shouldAttach(null, undefined)).toBe(false);
		expect(shouldAttach(null, "h")).toBe(false);
	});

	it("returns true when no previous hash is recorded", () => {
		expect(shouldAttach(ctx({ contentHash: "h" }), undefined)).toBe(true);
	});

	it("returns false when the hash matches the previous attachment", () => {
		expect(shouldAttach(ctx({ contentHash: "same" }), "same")).toBe(false);
	});

	it("returns true when the hash differs from the previous attachment", () => {
		expect(shouldAttach(ctx({ contentHash: "new" }), "old")).toBe(true);
	});
});
