import { describe, expect, it } from "vitest";
import {
	buildTitlePrompt,
	extractFirstExchange,
	parseTitleResponse,
	PER_TURN_TEXT_CAP,
} from "./titleSuggest";
import type { SessionRecord } from "./store";
import type { ChatTurn } from "../types";

describe("buildTitlePrompt", () => {
	it("wraps user/assistant text in the conversation tags", () => {
		const out = buildTitlePrompt({ firstUserText: "How do I install Rust?", firstAssistantText: "Use rustup." });
		expect(out).toContain("<conversation>");
		expect(out).toContain("<user>\nHow do I install Rust?\n</user>");
		expect(out).toContain("<assistant>\nUse rustup.\n</assistant>");
		expect(out).toContain("4-8 word title");
	});

	it("trims surrounding whitespace on each side", () => {
		const out = buildTitlePrompt({ firstUserText: "  hi  ", firstAssistantText: "\nhello\n" });
		expect(out).toContain("<user>\nhi\n</user>");
		expect(out).toContain("<assistant>\nhello\n</assistant>");
	});

	it("clips per-turn text past PER_TURN_TEXT_CAP with ellipsis", () => {
		const big = "x".repeat(PER_TURN_TEXT_CAP + 100);
		const out = buildTitlePrompt({ firstUserText: big, firstAssistantText: "ok" });
		const userBlock = out.match(/<user>\n([\s\S]*?)\n<\/user>/)![1]!;
		expect(userBlock.length).toBe(PER_TURN_TEXT_CAP);
		expect(userBlock.endsWith("…")).toBe(true);
	});

	it("respects a custom perTurnTextCap", () => {
		const out = buildTitlePrompt({
			firstUserText: "abcdefghij",
			firstAssistantText: "zz",
			perTurnTextCap: 5,
		});
		const userBlock = out.match(/<user>\n([\s\S]*?)\n<\/user>/)![1]!;
		expect(userBlock).toBe("abcd…");
	});
});

describe("parseTitleResponse", () => {
	it("returns ok with the result string when is_error is false", () => {
		const stdout = JSON.stringify({
			type: "result",
			is_error: false,
			result: "Installing Rust on macOS",
			total_cost_usd: 0.034,
		});
		const got = parseTitleResponse(stdout);
		expect(got).toEqual({ ok: true, title: "Installing Rust on macOS", costUsd: 0.034 });
	});

	it("returns err when is_error is true, surfacing the result string as the reason", () => {
		const stdout = JSON.stringify({
			is_error: true,
			result: "Not logged in · Please run /login",
		});
		const got = parseTitleResponse(stdout);
		expect(got).toEqual({ ok: false, reason: "Not logged in · Please run /login" });
	});

	it("ignores warning lines emitted before the JSON object", () => {
		const stdout = "Warning: claude.ai MCP servers blocked by enterprise policy\n" +
			JSON.stringify({ is_error: false, result: "A title", total_cost_usd: 0.001 });
		const got = parseTitleResponse(stdout);
		if (!got.ok) throw new Error("expected ok");
		expect(got.title).toBe("A title");
	});

	it("walks backward through lines to find the last parseable JSON object", () => {
		const stdout = [
			"junk line",
			"{ not actually json",
			JSON.stringify({ is_error: false, result: "Picked", total_cost_usd: 0 }),
			"trailing whitespace line",
			"",
		].join("\n");
		const got = parseTitleResponse(stdout);
		if (!got.ok) throw new Error("expected ok");
		expect(got.title).toBe("Picked");
	});

	it("returns err on completely non-JSON output", () => {
		const got = parseTitleResponse("this is not json at all\nneither is this");
		expect(got.ok).toBe(false);
		if (got.ok) return;
		expect(got.reason).toBe("non-JSON stdout");
	});

	it("returns err on empty result string", () => {
		const stdout = JSON.stringify({ is_error: false, result: "" });
		const got = parseTitleResponse(stdout);
		expect(got.ok).toBe(false);
		if (got.ok) return;
		expect(got.reason).toBe("empty result");
	});

	it("returns err on whitespace-only result string", () => {
		const stdout = JSON.stringify({ is_error: false, result: "   \n  " });
		const got = parseTitleResponse(stdout);
		expect(got.ok).toBe(false);
	});

	it("treats missing total_cost_usd as 0", () => {
		const stdout = JSON.stringify({ is_error: false, result: "X" });
		const got = parseTitleResponse(stdout);
		if (!got.ok) throw new Error("expected ok");
		expect(got.costUsd).toBe(0);
	});

	it("returns err for empty stdout", () => {
		expect(parseTitleResponse("")).toEqual({ ok: false, reason: "non-JSON stdout" });
		expect(parseTitleResponse("   \n").ok).toBe(false);
	});
});

describe("extractFirstExchange", () => {
	function record(turns: ChatTurn[]): SessionRecord {
		return {
			meta: { localId: "x", title: "t", createdAt: 0, updatedAt: 0, cwd: "/v" },
			turns,
			permissions: { allowedTools: [], deniedTools: [] },
		};
	}
	function userTurn(text: string): ChatTurn {
		return { role: "user", startedAt: 0, blocks: [{ type: "text", markdown: text }] };
	}
	function assistantTurn(text: string): ChatTurn {
		return { role: "assistant", startedAt: 0, blocks: [{ type: "text", markdown: text }] };
	}

	it("returns null when there is no user turn", () => {
		expect(extractFirstExchange(record([]))).toBeNull();
		expect(extractFirstExchange(record([assistantTurn("only assistant")]))).toBeNull();
	});

	it("returns null when there is no assistant turn", () => {
		expect(extractFirstExchange(record([userTurn("hello")]))).toBeNull();
	});

	it("returns the first user/assistant text pair", () => {
		const r = record([userTurn("Q"), assistantTurn("A1"), userTurn("Q2"), assistantTurn("A2")]);
		expect(extractFirstExchange(r)).toEqual({ user: "Q", assistant: "A1" });
	});

	it("ignores non-text blocks when collecting", () => {
		const r = record([
			{
				role: "user",
				startedAt: 0,
				blocks: [
					{ type: "context_attachment", path: "x", bytes: 0, kind: "note" },
					{ type: "text", markdown: "real question" },
				],
			},
			{
				role: "assistant",
				startedAt: 0,
				blocks: [
					{ type: "tool", toolUseId: "t", tool: "Read", input: {}, status: "ok" },
					{ type: "text", markdown: "real answer" },
				],
			},
		]);
		expect(extractFirstExchange(r)).toEqual({ user: "real question", assistant: "real answer" });
	});

	it("returns null when either side is empty/whitespace", () => {
		const r = record([userTurn("hi"), assistantTurn("   ")]);
		expect(extractFirstExchange(r)).toBeNull();
	});
});
