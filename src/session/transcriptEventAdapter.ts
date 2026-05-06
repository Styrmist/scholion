import type { NormalizedEvent } from "../backend/types";
import type { StreamEvent } from "../types";

// Translates the new NormalizedEvent shape back into the legacy StreamEvent
// shape that src/ui/transcript.ts already understands. Lets us swap the
// streaming pipeline without rewriting the transcript renderer; that
// rewrite is tracked in TODO.md.
//
// Semantics mirror the inverse of src/cli/eventTranslator.ts. Events
// without a transcript-side counterpart (turn.usage, turn.completed,
// turn.failed, tool.permission.requested, subagent.*, planMode.*,
// session.compaction.*) yield nothing — the coordinator handles them.
export function* normalizedToLegacy(
	events: Iterable<NormalizedEvent>,
): Iterable<StreamEvent> {
	for (const e of events) {
		const mapped = mapOne(e);
		if (mapped) yield mapped;
	}
}

export function mapOne(e: NormalizedEvent): StreamEvent | null {
	switch (e.type) {
		case "assistant.text.delta":
			return {
				kind: "assistant_text_delta",
				delta: e.text,
				messageId: e.messageId,
			};
		case "assistant.text.done":
			return {
				kind: "assistant_text",
				text: e.text,
				messageId: e.messageId,
			};
		case "tool.call.requested":
			return {
				kind: "tool_use",
				id: e.id,
				name: e.name,
				input: e.input,
			};
		case "tool.call.completed":
			return {
				kind: "tool_result",
				toolUseId: e.id,
				content: e.error ?? e.result ?? "",
				isError: e.error !== undefined,
			};
		default:
			return null;
	}
}
