import { describe, expect, it } from "vitest";
import { mapOne, normalizedToLegacy } from "./transcriptEventAdapter";

describe("transcriptEventAdapter", () => {
	it("maps assistant.text.delta -> assistant_text_delta", () => {
		expect(
			mapOne({
				type: "assistant.text.delta",
				text: "hi",
				messageId: "m1",
			}),
		).toEqual({ kind: "assistant_text_delta", delta: "hi", messageId: "m1" });
	});

	it("maps assistant.text.done -> assistant_text", () => {
		expect(
			mapOne({ type: "assistant.text.done", text: "hi there", messageId: "m1" }),
		).toEqual({ kind: "assistant_text", text: "hi there", messageId: "m1" });
	});

	it("maps tool.call.requested -> tool_use", () => {
		expect(
			mapOne({
				type: "tool.call.requested",
				id: "t1",
				name: "Read",
				input: { x: 1 },
			}),
		).toEqual({ kind: "tool_use", id: "t1", name: "Read", input: { x: 1 } });
	});

	it("maps tool.call.completed (success) -> tool_result with isError false", () => {
		expect(
			mapOne({
				type: "tool.call.completed",
				id: "t1",
				result: "ok",
			}),
		).toEqual({
			kind: "tool_result",
			toolUseId: "t1",
			content: "ok",
			isError: false,
		});
	});

	it("maps tool.call.completed (error) -> tool_result with isError true", () => {
		expect(
			mapOne({
				type: "tool.call.completed",
				id: "t1",
				error: "boom",
			}),
		).toEqual({
			kind: "tool_result",
			toolUseId: "t1",
			content: "boom",
			isError: true,
		});
	});

	it("yields null for events without a transcript counterpart", () => {
		expect(mapOne({ type: "turn.usage", cumulative: true, inputTokens: 1, outputTokens: 1 })).toBeNull();
		expect(mapOne({ type: "turn.completed", stopReason: "end_turn" })).toBeNull();
		expect(
			mapOne({
				type: "turn.failed",
				error: { code: "unknown", message: "x" },
			}),
		).toBeNull();
		expect(mapOne({ type: "session.compaction.started" })).toBeNull();
	});

	it("normalizedToLegacy strips events with no mapping", () => {
		const out = Array.from(
			normalizedToLegacy([
				{ type: "assistant.text.delta", text: "a", messageId: "m1" },
				{ type: "turn.usage", cumulative: true, inputTokens: 1, outputTokens: 1 },
				{ type: "assistant.text.done", text: "a", messageId: "m1" },
				{ type: "turn.completed", stopReason: "end_turn" },
			]),
		);
		expect(out.map((e) => e.kind)).toEqual([
			"assistant_text_delta",
			"assistant_text",
		]);
	});
});
