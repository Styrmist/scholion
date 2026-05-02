import { describe, expect, it } from "vitest";
import { normalize, parseToolFromHookName } from "./events";

describe("normalize", () => {
	it("non-objects return a single 'unknown' event without throwing", () => {
		expect(normalize(null)).toEqual([{ kind: "unknown", raw: null }]);
		expect(normalize(undefined)).toEqual([{ kind: "unknown", raw: undefined }]);
		expect(normalize(42)).toEqual([{ kind: "unknown", raw: 42 }]);
		expect(normalize("hi")).toEqual([{ kind: "unknown", raw: "hi" }]);
	});

	it("objects without 'type' fall through to 'unknown'", () => {
		expect(normalize({ no: "type" })).toEqual([{ kind: "unknown", raw: { no: "type" } }]);
	});

	it("system/init produces system_init with sessionId, model, tools", () => {
		const evs = normalize({
			type: "system",
			subtype: "init",
			session_id: "sess-1",
			model: "claude-sonnet-4-5",
			tools: ["Read", "Bash"],
		});
		expect(evs).toEqual([
			{ kind: "system_init", sessionId: "sess-1", model: "claude-sonnet-4-5", tools: ["Read", "Bash"] },
		]);
	});

	it("system/init with missing tools field omits the tools key", () => {
		const evs = normalize({ type: "system", subtype: "init", session_id: "s" });
		expect(evs).toHaveLength(1);
		expect(evs[0]).toMatchObject({ kind: "system_init", sessionId: "s" });
		expect((evs[0] as { tools?: unknown }).tools).toBeUndefined();
	});

	it("system/api_retry parses numeric fields with zero fallback", () => {
		const evs = normalize({
			type: "system",
			subtype: "api_retry",
			attempt: 2,
			max_retries: 5,
			retry_delay_ms: 1500,
			error_status: 429,
		});
		expect(evs).toEqual([
			{ kind: "api_retry", attempt: 2, maxRetries: 5, retryDelayMs: 1500, errorStatus: 429 },
		]);
	});

	it("system/api_retry coerces missing error_status to null", () => {
		const evs = normalize({ type: "system", subtype: "api_retry" });
		expect(evs[0]).toMatchObject({ kind: "api_retry", errorStatus: null, attempt: 0, maxRetries: 0 });
	});

	it("system/hook_started extracts toolName from 'PreToolUse:Bash'", () => {
		const evs = normalize({
			type: "system",
			subtype: "hook_started",
			hook_id: "h1",
			hook_event: "PreToolUse",
			hook_name: "PreToolUse:Bash",
		});
		expect(evs[0]).toMatchObject({
			kind: "hook_started",
			hookId: "h1",
			hookEvent: "PreToolUse",
			hookName: "PreToolUse:Bash",
			toolName: "Bash",
		});
	});

	it("system/hook_response with cancelled outcome normalizes to 'cancelled'", () => {
		const evs = normalize({
			type: "system",
			subtype: "hook_response",
			hook_id: "h",
			hook_event: "PreToolUse",
			hook_name: "PreToolUse:Edit",
			outcome: "cancelled",
			exit_code: 1,
			stdout: "",
			stderr: "boom",
		});
		expect(evs[0]).toMatchObject({ kind: "hook_response", outcome: "cancelled", stderr: "boom" });
	});

	it("system/hook_response with unknown outcome falls back to 'success'", () => {
		const evs = normalize({
			type: "system",
			subtype: "hook_response",
			hook_id: "h",
			hook_event: "PreToolUse",
			hook_name: "PreToolUse:Edit",
			outcome: "weird",
		});
		expect((evs[0] as { outcome: string }).outcome).toBe("success");
	});

	it("stream_event content_block_delta produces assistant_text_delta", () => {
		const evs = normalize({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" }, index: 0 },
			parent_message_id: "m1",
		});
		expect(evs).toEqual([{ kind: "assistant_text_delta", delta: "hi", messageId: "m1" }]);
	});

	it("stream_event prefers message.id over parent_message_id when present", () => {
		const evs = normalize({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
			message: { id: "m-real" },
			parent_message_id: "m-parent",
		});
		expect((evs[0] as { messageId: string }).messageId).toBe("m-real");
	});

	it("stream_event of unsupported type yields 'unknown'", () => {
		const evs = normalize({ type: "stream_event", event: { type: "ping" } });
		expect(evs[0]).toMatchObject({ kind: "unknown" });
	});

	it("assistant message with text → tool_use → text yields three events in document order", () => {
		const evs = normalize({
			type: "assistant",
			message: {
				id: "msg-1",
				content: [
					{ type: "text", text: "before" },
					{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a" } },
					{ type: "text", text: "after" },
				],
			},
		});
		expect(evs.map((e) => e.kind)).toEqual(["assistant_text", "tool_use", "assistant_text"]);
		expect(evs[0]).toMatchObject({ kind: "assistant_text", text: "before", messageId: "msg-1" });
		expect(evs[1]).toMatchObject({ kind: "tool_use", id: "tu-1", name: "Read" });
		expect(evs[2]).toMatchObject({ kind: "assistant_text", text: "after" });
	});

	it("assistant message with no usable blocks falls back to 'unknown'", () => {
		expect(normalize({ type: "assistant", message: { content: [] } })[0]).toMatchObject({ kind: "unknown" });
		expect(normalize({ type: "assistant", message: { content: [{ type: "thinking" }] } })[0]).toMatchObject({ kind: "unknown" });
	});

	it("user message tool_result with string content passes through", () => {
		const evs = normalize({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "hello", is_error: false }] },
		});
		expect(evs).toEqual([
			{ kind: "tool_result", toolUseId: "tu-1", content: "hello", isError: false },
		]);
	});

	it("user message tool_result with array of text blocks joins with newline", () => {
		const evs = normalize({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu-2",
						content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
						is_error: false,
					},
				],
			},
		});
		expect(evs[0]).toMatchObject({ content: "line1\nline2" });
	});

	it("tool_result with object content stringifies as JSON", () => {
		const evs = normalize({
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "tu", content: { foo: "bar" }, is_error: true }],
			},
		});
		expect((evs[0] as { content: string }).content).toBe('{"foo":"bar"}');
		expect((evs[0] as { isError: boolean }).isError).toBe(true);
	});

	it("result with subtype 'success' and usage produces a populated result event", () => {
		const evs = normalize({
			type: "result",
			subtype: "success",
			usage: { input_tokens: 10, output_tokens: 20 },
			total_cost_usd: 0.0123,
		});
		expect(evs[0]).toMatchObject({
			kind: "result",
			status: "success",
			subtype: "success",
			stopReason: "success",
			totalCostUsd: 0.0123,
		});
		expect((evs[0] as { usage: { input_tokens: number } }).usage.input_tokens).toBe(10);
	});

	it("result with subtype 'error_max_turns' is classified as error", () => {
		const evs = normalize({ type: "result", subtype: "error_max_turns" });
		expect((evs[0] as { status: string }).status).toBe("error");
	});

	it("result with subtype 'aborted_by_user' is classified as aborted", () => {
		const evs = normalize({ type: "result", subtype: "aborted_by_user" });
		expect((evs[0] as { status: string }).status).toBe("aborted");
	});

	it("result with is_error:true and benign subtype is classified as error", () => {
		const evs = normalize({ type: "result", subtype: "ok_ish", is_error: true });
		expect((evs[0] as { status: string }).status).toBe("error");
	});

	it("result with structured permission_denials field surfaces tool + reason", () => {
		const evs = normalize({
			type: "result",
			subtype: "success",
			permission_denials: [
				{ tool_name: "Bash", tool_use_id: "x", tool_input: { command: "ls" }, message: "Bash blocked by deny rule" },
			],
		});
		expect((evs[0] as { permissionDenied?: { tool: string; reason: string } }).permissionDenied)
			.toEqual({ tool: "Bash", reason: "Bash blocked by deny rule" });
	});

	it("result with structured permission_denials missing message synthesizes a reason", () => {
		const evs = normalize({
			type: "result",
			subtype: "success",
			permission_denials: [{ tool_name: "Edit", tool_use_id: "x", tool_input: {} }],
		});
		const denial = (evs[0] as { permissionDenied?: { tool: string; reason: string } }).permissionDenied;
		expect(denial?.tool).toBe("Edit");
		expect(denial?.reason).toMatch(/blocked by permission/i);
	});

	it("result fallback regex catches CLI strings without permission_denials", () => {
		const evs = normalize({
			type: "result",
			subtype: "success",
			error: 'tool "Bash" requires approval',
		});
		const denial = (evs[0] as { permissionDenied?: { tool: string; reason: string } }).permissionDenied;
		expect(denial?.tool).toBe("Bash");
		expect(denial?.reason).toBe('tool "Bash" requires approval');
	});

	it("result fallback regex returns 'Unknown' when message has no extractable tool name", () => {
		const evs = normalize({
			type: "result",
			subtype: "success",
			error: "Permission denied for the action",
		});
		const denial = (evs[0] as { permissionDenied?: { tool: string } }).permissionDenied;
		// Pattern matches 'permission denied' but no `tool X` phrase to extract.
		expect(denial?.tool).toBe("Unknown");
	});

	it("result with no denial signal leaves permissionDenied undefined", () => {
		const evs = normalize({ type: "result", subtype: "success" });
		expect((evs[0] as { permissionDenied?: unknown }).permissionDenied).toBeUndefined();
	});

	it("result.errors is filtered to strings only", () => {
		const evs = normalize({ type: "result", subtype: "success", errors: ["a", 1, null, "b"] });
		expect((evs[0] as { errors?: string[] }).errors).toEqual(["a", "b"]);
	});
});

describe("parseToolFromHookName", () => {
	it("'PreToolUse:Bash' → 'Bash'", () => {
		expect(parseToolFromHookName("PreToolUse:Bash")).toBe("Bash");
	});

	it("trims surrounding whitespace from the tail", () => {
		expect(parseToolFromHookName("PreToolUse:   Edit  ")).toBe("Edit");
	});

	it("returns undefined when no colon", () => {
		expect(parseToolFromHookName("PreToolUse")).toBeUndefined();
	});

	it("returns undefined when colon is followed only by whitespace", () => {
		expect(parseToolFromHookName("PreToolUse:   ")).toBeUndefined();
	});

	it("empty string → undefined", () => {
		expect(parseToolFromHookName("")).toBeUndefined();
	});
});
