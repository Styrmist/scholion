import { PERMISSION_DENIAL_PATTERNS } from "../../constants";
import { StreamEvent, UsageInfo } from "../../types";

interface RawEvent {
	type?: string;
	subtype?: string;
	[k: string]: unknown;
}

export function normalize(raw: unknown): StreamEvent[] {
	if (!raw || typeof raw !== "object") return [{ kind: "unknown", raw }];
	const r = raw as RawEvent;

	if (r.type === "system" && r.subtype === "init") {
		return [{
			kind: "system_init",
			sessionId: stringField(r, "session_id"),
			model: stringFieldOrUndefined(r, "model"),
			tools: Array.isArray(r["tools"]) ? (r["tools"] as string[]) : undefined,
		}];
	}

	if (r.type === "system" && r.subtype === "api_retry") {
		return [{
			kind: "api_retry",
			attempt: numberField(r, "attempt"),
			maxRetries: numberField(r, "max_retries"),
			retryDelayMs: numberField(r, "retry_delay_ms"),
			errorStatus: typeof r["error_status"] === "number" ? r["error_status"] : null,
		}];
	}

	if (r.type === "system" && r.subtype === "hook_started") {
		const hookName = stringField(r, "hook_name");
		return [{
			kind: "hook_started",
			hookId: stringField(r, "hook_id"),
			hookEvent: stringField(r, "hook_event"),
			hookName,
			toolName: parseToolFromHookName(hookName),
		}];
	}

	if (r.type === "system" && r.subtype === "hook_response") {
		const hookName = stringField(r, "hook_name");
		const outcomeRaw = stringField(r, "outcome");
		const outcome: "success" | "cancelled" = outcomeRaw === "cancelled" ? "cancelled" : "success";
		return [{
			kind: "hook_response",
			hookId: stringField(r, "hook_id"),
			hookEvent: stringField(r, "hook_event"),
			hookName,
			toolName: parseToolFromHookName(hookName),
			outcome,
			exitCode: numberField(r, "exit_code"),
			stdout: stringField(r, "stdout"),
			stderr: stringField(r, "stderr"),
		}];
	}

	if (r.type === "stream_event") {
		const event = r["event"] as { type?: string; delta?: { type?: string; text?: string }; index?: number } | undefined;
		if (event && event.type === "content_block_delta" && event.delta?.type === "text_delta") {
			return [{
				kind: "assistant_text_delta",
				delta: typeof event.delta.text === "string" ? event.delta.text : "",
				messageId: extractStreamMessageId(r),
			}];
		}
		return [{ kind: "unknown", raw: r }];
	}

	if (r.type === "assistant") {
		const message = r["message"] as { id?: string; content?: unknown[] } | undefined;
		const messageId = message?.id ?? "";
		const blocks = Array.isArray(message?.content) ? (message.content as RawEvent[]) : [];
		const events: StreamEvent[] = [];
		for (const block of blocks) {
			if (block.type === "text") {
				events.push({ kind: "assistant_text", text: stringField(block, "text"), messageId });
			} else if (block.type === "tool_use") {
				events.push({
					kind: "tool_use",
					id: stringField(block, "id"),
					name: stringField(block, "name"),
					input: block["input"],
				});
			}
		}
		if (events.length === 0) return [{ kind: "unknown", raw: r }];
		return events;
	}

	if (r.type === "user") {
		const message = r["message"] as { content?: unknown[] } | undefined;
		const blocks = Array.isArray(message?.content) ? (message.content as RawEvent[]) : [];
		const events: StreamEvent[] = [];
		for (const block of blocks) {
			if (block.type === "tool_result") {
				events.push({
					kind: "tool_result",
					toolUseId: stringField(block, "tool_use_id"),
					content: stringifyToolResultContent(block["content"]),
					isError: Boolean(block["is_error"]),
				});
			}
		}
		if (events.length === 0) return [{ kind: "unknown", raw: r }];
		return events;
	}

	if (r.type === "result") {
		const status = inferResultStatus(r);
		const usage = (r["usage"] as UsageInfo) ?? undefined;
		const totalCostUsd = typeof r["total_cost_usd"] === "number" ? r["total_cost_usd"] : undefined;
		const subtype = stringFieldOrUndefined(r, "subtype");
		const stopReason = stringFieldOrUndefined(r, "stop_reason") ?? subtype;
		const errors = Array.isArray(r["errors"])
			? (r["errors"] as unknown[]).filter((e): e is string => typeof e === "string")
			: undefined;
		const denial = denialFromStructuredField(r) ?? detectPermissionDenial(r);
		return [{
			kind: "result",
			status,
			subtype,
			stopReason,
			usage,
			totalCostUsd,
			errors,
			permissionDenied: denial,
		}];
	}

	return [{ kind: "unknown", raw: r }];
}

function extractStreamMessageId(r: RawEvent): string {
	const message = r["message"] as { id?: string } | undefined;
	if (message?.id) return message.id;
	const parentMsg = stringFieldOrUndefined(r, "parent_message_id");
	if (parentMsg) return parentMsg;
	return "";
}

function inferResultStatus(r: RawEvent): "success" | "error" | "aborted" {
	const subtype = stringFieldOrUndefined(r, "subtype");
	if (subtype && /abort/i.test(subtype)) return "aborted";
	if (subtype && /error/i.test(subtype)) return "error";
	if (r["is_error"] === true) return "error";
	return "success";
}

function denialFromStructuredField(r: RawEvent): { tool: string; reason: string } | undefined {
	const denials = r["permission_denials"];
	if (!Array.isArray(denials) || denials.length === 0) return undefined;
	const first = denials[0] as { tool_name?: unknown; tool?: unknown; message?: unknown };
	const tool =
		(typeof first.tool_name === "string" && first.tool_name) ||
		(typeof first.tool === "string" && first.tool) ||
		"Unknown";
	const reason =
		typeof first.message === "string" && first.message
			? first.message
			: `${tool} was blocked by permission settings`;
	return { tool, reason };
}

// Fallback for CLI versions that don't emit the structured `permission_denials` array.
function detectPermissionDenial(r: RawEvent): { tool: string; reason: string } | undefined {
	const candidates: string[] = [];
	for (const k of ["error", "result", "message", "subtype", "stop_reason"]) {
		const v = r[k];
		if (typeof v === "string") candidates.push(v);
	}
	for (const message of candidates) {
		if (PERMISSION_DENIAL_PATTERNS.some((re) => re.test(message))) {
			const toolMatch = message.match(/tool[s]?\s+"?([A-Z][A-Za-z]+)"?/);
			return { tool: toolMatch?.[1] ?? "Unknown", reason: message };
		}
	}
	return undefined;
}

function stringifyToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((piece) => {
				if (typeof piece === "string") return piece;
				if (piece && typeof piece === "object" && "text" in piece) {
					const text = (piece as { text?: unknown }).text;
					return typeof text === "string" ? text : JSON.stringify(piece);
				}
				return JSON.stringify(piece);
			})
			.join("\n");
	}
	if (content && typeof content === "object") return JSON.stringify(content);
	if (content === undefined || content === null) return "";
	if (typeof content === "string" || typeof content === "number" || typeof content === "boolean") {
		return String(content);
	}
	return JSON.stringify(content);
}

function stringField(r: RawEvent, key: string): string {
	const v = r[key];
	return typeof v === "string" ? v : "";
}

function stringFieldOrUndefined(r: RawEvent, key: string): string | undefined {
	const v = r[key];
	return typeof v === "string" ? v : undefined;
}

function numberField(r: RawEvent, key: string): number {
	const v = r[key];
	return typeof v === "number" ? v : 0;
}

// Hook names look like "PreToolUse:Bash" — extract the trailing tool name when present.
export function parseToolFromHookName(hookName: string): string | undefined {
	const idx = hookName.indexOf(":");
	if (idx < 0) return undefined;
	const tail = hookName.slice(idx + 1).trim();
	return tail.length > 0 ? tail : undefined;
}
