import { describe, expect, it } from "vitest";
import { translateClaudeEvent, translateAll } from "./eventTranslator";
import type { StreamEvent } from "../types";

describe("translateClaudeEvent", () => {
	it("captures system_init.sessionId out-of-band, not as an event", () => {
		const out = translateClaudeEvent({
			kind: "system_init",
			sessionId: "claude-uuid-abc",
			model: "sonnet",
		});
		expect(out.events).toEqual([]);
		expect(out.nativeSessionId).toBe("claude-uuid-abc");
	});

	it("translates assistant_text_delta", () => {
		const out = translateClaudeEvent({
			kind: "assistant_text_delta",
			delta: "Hello",
			messageId: "m1",
		});
		expect(out.events).toEqual([
			{ type: "assistant.text.delta", messageId: "m1", text: "Hello" },
		]);
	});

	it("translates assistant_text to assistant.text.done", () => {
		const out = translateClaudeEvent({
			kind: "assistant_text",
			text: "All done",
			messageId: "m1",
		});
		expect(out.events).toEqual([
			{ type: "assistant.text.done", messageId: "m1", text: "All done" },
		]);
	});

	it("translates tool_use to tool.call.requested", () => {
		const out = translateClaudeEvent({
			kind: "tool_use",
			id: "tool_001",
			name: "Read",
			input: { file_path: "README.md" },
		});
		expect(out.events).toEqual([
			{
				type: "tool.call.requested",
				id: "tool_001",
				name: "Read",
				input: { file_path: "README.md" },
			},
		]);
	});

	it("translates tool_result success to tool.call.completed with result", () => {
		const out = translateClaudeEvent({
			kind: "tool_result",
			toolUseId: "tool_001",
			content: "file contents",
			isError: false,
		});
		expect(out.events).toEqual([
			{ type: "tool.call.completed", id: "tool_001", result: "file contents" },
		]);
	});

	it("translates tool_result error to tool.call.completed with error", () => {
		const out = translateClaudeEvent({
			kind: "tool_result",
			toolUseId: "tool_001",
			content: "ENOENT",
			isError: true,
		});
		expect(out.events).toEqual([
			{ type: "tool.call.completed", id: "tool_001", error: "ENOENT" },
		]);
	});

	it("translates result success: usage snapshot then turn.completed", () => {
		const out = translateClaudeEvent({
			kind: "result",
			status: "success",
			stopReason: "end_turn",
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 20,
			},
			totalCostUsd: 0.01,
		});
		expect(out.events).toEqual([
			{
				type: "turn.usage",
				cumulative: true,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 20,
				costUsd: 0.01,
			},
			{ type: "turn.completed", stopReason: "end_turn" },
		]);
	});

	it("translates result aborted to turn.completed with cancelled stop reason", () => {
		const out = translateClaudeEvent({
			kind: "result",
			status: "aborted",
		});
		expect(out.events).toEqual([
			{ type: "turn.completed", stopReason: "cancelled" },
		]);
	});

	it("translates result error to turn.failed with classified error", () => {
		const out = translateClaudeEvent({
			kind: "result",
			status: "error",
			errors: ["session not found"],
		});
		expect(out.events).toHaveLength(1);
		expect(out.events[0]).toMatchObject({
			type: "turn.failed",
			error: { code: "session_not_found" },
		});
	});

	it("translates result with permissionDenied to turn.failed permission_denied", () => {
		const out = translateClaudeEvent({
			kind: "result",
			status: "error",
			permissionDenied: { tool: "Bash", reason: "Bash blocked by hook" },
		});
		expect(out.events[0]).toMatchObject({
			type: "turn.failed",
			error: { code: "permission_denied", message: "Bash blocked by hook" },
		});
	});

	it("api_retry routes to diagnostics, not events", () => {
		const out = translateClaudeEvent({
			kind: "api_retry",
			attempt: 1,
			maxRetries: 3,
			retryDelayMs: 500,
			errorStatus: 503,
		});
		expect(out.events).toEqual([]);
		expect(out.diagnostics[0]).toMatchObject({
			severity: "warn",
			source: "cli",
		});
		expect(out.diagnostics[0]?.message).toContain("503");
	});

	it("stderr routes to diagnostics", () => {
		const out = translateClaudeEvent({ kind: "stderr", line: "warn: foo" });
		expect(out.events).toEqual([]);
		expect(out.diagnostics).toEqual([
			expect.objectContaining({
				severity: "warn",
				source: "stderr",
				message: "warn: foo",
			}),
		]);
	});

	it("hook_started and hook_response are suppressed (backend-internal)", () => {
		const a = translateClaudeEvent({
			kind: "hook_started",
			hookId: "h1",
			hookEvent: "PreToolUse",
			hookName: "PreToolUse:Bash",
			toolName: "Bash",
		});
		const b = translateClaudeEvent({
			kind: "hook_response",
			hookId: "h1",
			hookEvent: "PreToolUse",
			hookName: "PreToolUse:Bash",
			toolName: "Bash",
			outcome: "success",
			exitCode: 0,
			stdout: "",
			stderr: "",
		});
		expect(a.events).toEqual([]);
		expect(a.diagnostics).toEqual([]);
		expect(b.events).toEqual([]);
		expect(b.diagnostics).toEqual([]);
	});

	it("unknown events route to info-level diagnostics", () => {
		const out = translateClaudeEvent({ kind: "unknown", raw: { foo: 1 } });
		expect(out.events).toEqual([]);
		expect(out.diagnostics[0]?.severity).toBe("info");
	});
});

describe("translateAll", () => {
	it("processes a full success turn end to end", () => {
		const seq: StreamEvent[] = [
			{ kind: "system_init", sessionId: "S1", model: "sonnet" },
			{ kind: "assistant_text_delta", delta: "Hi", messageId: "m1" },
			{ kind: "assistant_text_delta", delta: " there", messageId: "m1" },
			{ kind: "assistant_text", text: "Hi there", messageId: "m1" },
			{
				kind: "result",
				status: "success",
				stopReason: "end_turn",
				usage: { input_tokens: 5, output_tokens: 3 },
				totalCostUsd: 0.001,
			},
		];
		const out = translateAll(seq);
		expect(out.nativeSessionId).toBe("S1");
		expect(out.events.map((e) => e.type)).toEqual([
			"assistant.text.delta",
			"assistant.text.delta",
			"assistant.text.done",
			"turn.usage",
			"turn.completed",
		]);
	});

	it("processes a tool-using turn", () => {
		const seq: StreamEvent[] = [
			{ kind: "system_init", sessionId: "S2" },
			{
				kind: "tool_use",
				id: "t1",
				name: "Read",
				input: { file_path: "x.md" },
			},
			{
				kind: "tool_result",
				toolUseId: "t1",
				content: "x contents",
				isError: false,
			},
			{
				kind: "assistant_text",
				text: "It says: x contents",
				messageId: "m1",
			},
			{ kind: "result", status: "success", stopReason: "end_turn" },
		];
		const out = translateAll(seq);
		expect(out.events.map((e) => e.type)).toEqual([
			"tool.call.requested",
			"tool.call.completed",
			"assistant.text.done",
			"turn.completed",
		]);
	});

	it("processes a session_not_found error turn", () => {
		const seq: StreamEvent[] = [
			{
				kind: "result",
				status: "error",
				errors: ["session not found: abc"],
			},
		];
		const out = translateAll(seq);
		expect(out.events).toHaveLength(1);
		expect(out.events[0]).toMatchObject({
			type: "turn.failed",
			error: { code: "session_not_found" },
		});
	});
});
