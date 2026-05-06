import { describe, expect, it } from "vitest";
import { mapClaudeStopReason } from "./stopReasonMap";

describe("mapClaudeStopReason", () => {
	it("aborted status overrides any stop reason", () => {
		expect(mapClaudeStopReason("end_turn", "aborted")).toBe("cancelled");
		expect(mapClaudeStopReason(undefined, "aborted")).toBe("cancelled");
	});

	it("undefined stop reason: success -> end_turn, error -> error", () => {
		expect(mapClaudeStopReason(undefined, "success")).toBe("end_turn");
		expect(mapClaudeStopReason(undefined, "error")).toBe("error");
	});

	it("recognized Claude reasons map directly", () => {
		expect(mapClaudeStopReason("end_turn", "success")).toBe("end_turn");
		expect(mapClaudeStopReason("tool_use", "success")).toBe("tool_use");
		expect(mapClaudeStopReason("max_tokens", "success")).toBe("max_tokens");
		expect(mapClaudeStopReason("stop_sequence", "success")).toBe(
			"stop_sequence",
		);
		expect(mapClaudeStopReason("refusal", "success")).toBe("content_filter");
		expect(mapClaudeStopReason("error_max_turns", "error")).toBe("max_tokens");
	});

	it("aborted reason maps to cancelled regardless of status", () => {
		expect(mapClaudeStopReason("aborted", "success")).toBe("cancelled");
		expect(mapClaudeStopReason("cancelled", "error")).toBe("cancelled");
	});

	it("unknown reasons fall back to status default", () => {
		expect(mapClaudeStopReason("mystery_reason", "success")).toBe("end_turn");
		expect(mapClaudeStopReason("mystery_reason", "error")).toBe("error");
	});
});
