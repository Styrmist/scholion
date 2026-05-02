import { describe, expect, it } from "vitest";
import { summarizeLastAssistantTurn, summarizeText } from "./summarize";
import { SessionRecord } from "./store";

function record(turns: SessionRecord["turns"]): SessionRecord {
	return {
		meta: { localId: "l", title: "t", createdAt: 0, updatedAt: 0, cwd: "/" },
		turns,
		permissions: { allowedTools: [], deniedTools: [] },
	};
}

describe("summarizeText", () => {
	it("returns empty for empty/whitespace input", () => {
		expect(summarizeText("")).toBe("");
		expect(summarizeText("    \n\t   ")).toBe("");
	});

	it("collapses consecutive whitespace into a single space", () => {
		expect(summarizeText("hello   world\nhow\tare you.")).toBe("hello world how are you.");
	});

	it("returns the first sentence when terminated by . ! or ?", () => {
		expect(summarizeText("Hi there. More follows.")).toBe("Hi there.");
		expect(summarizeText("Yes! Then no.")).toBe("Yes!");
		expect(summarizeText("Why? Because.")).toBe("Why?");
	});

	it("hard-cuts to 140 chars when no sentence boundary in range (no ellipsis on bare slice)", () => {
		const long = "x".repeat(200);
		const out = summarizeText(long);
		expect(out.length).toBe(140);
		// The implementation only adds ellipsis when summary > 140; a bare slice
		// of exactly 140 is returned as-is.
		expect(out.endsWith("…")).toBe(false);
	});

	it("trims with ellipsis when the regex match (incl. trailing whitespace) exceeds 140", () => {
		// Regex: ^.{1,140}?[.!?](?:\s|$)
		// 140 chars + '.' + ' ' = 142-char match → 141 after trim → ellipsis branch.
		const text = "a".repeat(140) + ". rest";
		const out = summarizeText(text);
		expect(out.length).toBe(140);
		expect(out.endsWith("…")).toBe(true);
	});

	it("returns input unchanged when already under 140 chars without sentence end", () => {
		const text = "no terminator here";
		expect(summarizeText(text)).toBe("no terminator here");
	});

	it("prefers a sentence boundary inside the 140-char window over a hard cut", () => {
		const sentence = "First short. ";
		const tail = "x".repeat(200);
		const out = summarizeText(sentence + tail);
		expect(out).toBe("First short.");
	});

	it("handles a sentence boundary exactly at position 140", () => {
		const text = "a".repeat(139) + "."; // 140 chars total ending in '.'
		const out = summarizeText(text);
		expect(out.length).toBeLessThanOrEqual(140);
		expect(out.endsWith(".")).toBe(true);
	});

	it("a multi-sentence paragraph yields only the first sentence", () => {
		expect(summarizeText("One. Two. Three.")).toBe("One.");
	});
});

describe("summarizeLastAssistantTurn", () => {
	it("returns undefined for an empty record", () => {
		expect(summarizeLastAssistantTurn(record([]))).toBeUndefined();
	});

	it("returns undefined when only user turns exist", () => {
		expect(summarizeLastAssistantTurn(record([
			{ role: "user", blocks: [{ type: "text", markdown: "hi" }], startedAt: 0 },
		]))).toBeUndefined();
	});

	it("walks back to the most recent assistant turn (skipping later user turns)", () => {
		const r = record([
			{ role: "assistant", blocks: [{ type: "text", markdown: "First answer." }], startedAt: 0 },
			{ role: "user", blocks: [{ type: "text", markdown: "follow up" }], startedAt: 1 },
		]);
		expect(summarizeLastAssistantTurn(r)).toBe("First answer.");
	});

	it("uses the first non-empty text block of the chosen assistant turn", () => {
		const r = record([
			{
				role: "assistant",
				blocks: [
					{ type: "text", markdown: "" },
					{ type: "text", markdown: "Real answer." },
				],
				startedAt: 0,
			},
		]);
		expect(summarizeLastAssistantTurn(r)).toBe("Real answer.");
	});

	it("returns undefined when the last assistant turn has no text blocks", () => {
		const r = record([
			{
				role: "assistant",
				blocks: [
					{ type: "tool", toolUseId: "x", tool: "Read", input: {}, status: "ok" },
				],
				startedAt: 0,
			},
		]);
		expect(summarizeLastAssistantTurn(r)).toBeUndefined();
	});
});
