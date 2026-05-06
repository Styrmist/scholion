import type { StopReason } from "../backend/types";

// Translates Claude's stop_reason / result.subtype strings into the normalized
// StopReason union. The Claude wire vocabulary spans `message_delta.stop_reason`
// (end_turn, tool_use, max_tokens, stop_sequence, refusal) and `result.subtype`
// (success, aborted, error_*).
export function mapClaudeStopReason(
	stopReason: string | undefined,
	status: "success" | "error" | "aborted",
): StopReason {
	if (status === "aborted") return "cancelled";
	if (!stopReason) return status === "success" ? "end_turn" : "error";
	switch (stopReason) {
		case "end_turn":
		case "success":
			return "end_turn";
		case "tool_use":
			return "tool_use";
		case "max_tokens":
		case "error_max_turns":
			return "max_tokens";
		case "stop_sequence":
			return "stop_sequence";
		case "refusal":
		case "content_filter":
			return "content_filter";
		case "aborted":
		case "cancelled":
			return "cancelled";
		default:
			return status === "success" ? "end_turn" : "error";
	}
}
