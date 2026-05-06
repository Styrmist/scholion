import type { StreamEvent } from "../../types";
import type {
	NormalizedEvent,
	DiagnosticEvent,
} from "../../backend/types";
import { mapClaudeStopReason } from "./stopReasonMap";
import { mapClaudeError } from "./errorMap";

export interface TranslatorOutput {
	events: NormalizedEvent[];
	diagnostics: DiagnosticEvent[];
	// Captured but not part of the NormalizedEvent stream (Leak G). The Claude
	// backend writes this into its native session map.
	nativeSessionId?: string;
}

// Pure translator from one StreamEvent to facade events + side-channel diagnostics.
// Suppresses Claude-internal events (system_init, hook_started/response) that
// the backend handles privately.
export function translateClaudeEvent(raw: StreamEvent): TranslatorOutput {
	const out: TranslatorOutput = { events: [], diagnostics: [] };

	switch (raw.kind) {
		case "system_init":
			out.nativeSessionId = raw.sessionId;
			return out;

		case "assistant_text_delta":
			out.events.push({
				type: "assistant.text.delta",
				messageId: raw.messageId,
				text: raw.delta,
			});
			return out;

		case "assistant_text":
			out.events.push({
				type: "assistant.text.done",
				messageId: raw.messageId,
				text: raw.text,
			});
			return out;

		case "tool_use":
			out.events.push({
				type: "tool.call.requested",
				id: raw.id,
				name: raw.name,
				input: raw.input,
			});
			return out;

		case "tool_result":
			out.events.push({
				type: "tool.call.completed",
				id: raw.toolUseId,
				...(raw.isError
					? { error: raw.content }
					: { result: raw.content }),
			});
			return out;

		case "result": {
			if (raw.usage || typeof raw.totalCostUsd === "number") {
				out.events.push({
					type: "turn.usage",
					cumulative: true,
					inputTokens: raw.usage?.input_tokens ?? 0,
					outputTokens: raw.usage?.output_tokens ?? 0,
					...(typeof raw.usage?.cache_read_input_tokens === "number" && {
						cacheReadTokens: raw.usage.cache_read_input_tokens,
					}),
					...(typeof raw.usage?.cache_creation_input_tokens === "number" && {
						cacheCreationTokens: raw.usage.cache_creation_input_tokens,
					}),
					...(typeof raw.totalCostUsd === "number" && {
						costUsd: raw.totalCostUsd,
					}),
				});
			}
			if (raw.status === "success") {
				out.events.push({
					type: "turn.completed",
					stopReason: mapClaudeStopReason(raw.stopReason, raw.status),
				});
			} else if (raw.status === "aborted") {
				out.events.push({
					type: "turn.completed",
					stopReason: "cancelled",
				});
			} else {
				out.events.push({
					type: "turn.failed",
					error: mapClaudeError({
						status: raw.status,
						resultErrors: raw.errors,
						subtype: raw.subtype,
						permissionDenied: raw.permissionDenied,
					}),
				});
			}
			return out;
		}

		case "api_retry":
			out.diagnostics.push({
				severity: "warn",
				source: "cli",
				message: `API retry ${raw.attempt}/${raw.maxRetries} in ${raw.retryDelayMs}ms${raw.errorStatus ? ` (status ${raw.errorStatus})` : ""}`,
				ts: Date.now(),
			});
			return out;

		case "stderr":
			out.diagnostics.push({
				severity: "warn",
				source: "stderr",
				message: raw.line,
				ts: Date.now(),
			});
			return out;

		case "hook_started":
		case "hook_response":
			// Backend-internal; surfaced through the permission flow, not this stream.
			return out;

		case "unknown":
			out.diagnostics.push({
				severity: "info",
				source: "cli",
				message: "Unrecognized stream event",
				raw: JSON.stringify(raw.raw),
				ts: Date.now(),
			});
			return out;
	}
}

// Convenience batch translator. Processes a sequence and returns the full
// outputs for tests; production code calls translateClaudeEvent per event so
// it can interleave with permission and abort signals.
export function translateAll(events: Iterable<StreamEvent>): {
	events: NormalizedEvent[];
	diagnostics: DiagnosticEvent[];
	nativeSessionId?: string;
} {
	const all: NormalizedEvent[] = [];
	const diags: DiagnosticEvent[] = [];
	let nativeSessionId: string | undefined;
	for (const e of events) {
		const out = translateClaudeEvent(e);
		all.push(...out.events);
		diags.push(...out.diagnostics);
		if (out.nativeSessionId) nativeSessionId = out.nativeSessionId;
	}
	return { events: all, diagnostics: diags, ...(nativeSessionId && { nativeSessionId }) };
}
