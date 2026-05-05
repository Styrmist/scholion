import { describe, expect, it } from "vitest";
import {
	defaultExportFilename,
	DEFAULT_EXPORT_FOLDER,
	formatTranscriptAsMarkdown,
	normalizeExportPath,
	slugifyForFilename,
} from "./exportMarkdown";
import type { SessionRecord } from "./store";
import type { ChatTurn, SessionMeta } from "../types";

function mkMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		localId: "local-1",
		title: "Test chat",
		// 2026-05-05 12:00 UTC; rendered as local time so test only asserts presence.
		createdAt: 1778414400000,
		updatedAt: 1778414400000,
		cwd: "/vault/test",
		...overrides,
	};
}

function mkRecord(turns: ChatTurn[], metaOverrides: Partial<SessionMeta> = {}): SessionRecord {
	return {
		meta: mkMeta(metaOverrides),
		turns,
		permissions: { allowedTools: [], deniedTools: [] },
	};
}

describe("formatTranscriptAsMarkdown", () => {
	it("renders a header with title, dates, and cwd", () => {
		const out = formatTranscriptAsMarkdown(mkRecord([]));
		expect(out).toMatch(/^# Test chat/);
		expect(out).toContain("**Created:**");
		expect(out).toContain("**Updated:**");
		expect(out).toContain("`/vault/test`");
	});

	it("falls back to a default title when meta.title is empty", () => {
		const out = formatTranscriptAsMarkdown(mkRecord([], { title: "" }));
		expect(out).toMatch(/^# Claude chat/);
	});

	it("includes model and usage when present", () => {
		const record = mkRecord([], { model: "opus" });
		record.usage = { totalCostUsd: 0.1234, inputTokens: 12345, outputTokens: 678, cacheReadTokens: 0, cacheCreationTokens: 0 };
		const out = formatTranscriptAsMarkdown(record);
		expect(out).toContain("**Model:** `opus`");
		expect(out).toContain("$0.1234");
		expect(out).toContain("12k in");
	});

	it("omits the usage line when totals are all zero", () => {
		const record = mkRecord([]);
		record.usage = { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
		expect(formatTranscriptAsMarkdown(record)).not.toContain("**Usage:**");
	});

	it("renders a single user/assistant pair with role headings", () => {
		const turns: ChatTurn[] = [
			{ role: "user", startedAt: 1778414400000, blocks: [{ type: "text", markdown: "Hello there" }] },
			{ role: "assistant", startedAt: 1778414400500, blocks: [{ type: "text", markdown: "Hi back!" }] },
		];
		const out = formatTranscriptAsMarkdown(mkRecord(turns));
		expect(out).toMatch(/## You — /);
		expect(out).toMatch(/## Claude — /);
		expect(out).toContain("Hello there");
		expect(out).toContain("Hi back!");
	});

	it("renders a tool block with input JSON, output fence, and ✅ status", () => {
		const turns: ChatTurn[] = [
			{
				role: "assistant",
				startedAt: 1778414400000,
				blocks: [
					{
						type: "tool",
						toolUseId: "t1",
						tool: "Read",
						status: "ok",
						input: { path: "/foo.md", offset: 1 },
						output: "line1\nline2\n",
					},
				],
			},
		];
		const out = formatTranscriptAsMarkdown(mkRecord(turns));
		expect(out).toContain("### 🔧 Read — ✅ ok");
		expect(out).toContain('"path": "/foo.md"');
		expect(out).toContain("line1\nline2");
	});

	it("marks the status as denied/error/aborted distinctly", () => {
		const mk = (status: ChatTurn["blocks"][number] extends infer B ? B extends { status: infer S } ? S : never : never): ChatTurn => ({
			role: "assistant",
			startedAt: 0,
			blocks: [{ type: "tool", toolUseId: "t", tool: "Bash", input: {}, status: status as never }],
		});
		expect(formatTranscriptAsMarkdown(mkRecord([mk("denied" as never)]))).toContain("🚫 denied");
		expect(formatTranscriptAsMarkdown(mkRecord([mk("aborted" as never)]))).toContain("⏹ aborted");
		expect(formatTranscriptAsMarkdown(mkRecord([mk("error" as never)]))).toContain("❌ error");
	});

	it("isError true overrides the textual status", () => {
		const turns: ChatTurn[] = [{
			role: "assistant",
			startedAt: 0,
			blocks: [{ type: "tool", toolUseId: "t", tool: "Bash", input: {}, status: "ok", isError: true, output: "boom" }],
		}];
		const out = formatTranscriptAsMarkdown(mkRecord(turns));
		expect(out).toContain("❌ error");
	});

	it("truncates tool output beyond the cap and notes the original size", () => {
		const big = "x".repeat(10_000);
		const turns: ChatTurn[] = [{
			role: "assistant",
			startedAt: 0,
			blocks: [{ type: "tool", toolUseId: "t", tool: "Read", input: {}, status: "ok", output: big }],
		}];
		const out = formatTranscriptAsMarkdown(mkRecord(turns), { toolOutputMaxBytes: 100 });
		expect(out).toContain("truncated to 100 B");
		expect(out).toContain("9.8 KB");
		expect(out).toContain("…");
		// The truncated fence body has a length under cap+ellipsis
		const matches = out.match(/```\nx+/);
		expect(matches?.[0].length).toBeLessThanOrEqual(120);
	});

	it("uses a longer fence when the tool output contains a triple backtick run", () => {
		const turns: ChatTurn[] = [{
			role: "assistant",
			startedAt: 0,
			blocks: [{ type: "tool", toolUseId: "t", tool: "Read", input: {}, status: "ok", output: "```code inside```" }],
		}];
		const out = formatTranscriptAsMarkdown(mkRecord(turns));
		expect(out).toMatch(/````\n```code inside```\n````/);
	});

	it("renders context attachment blocks as a callout-style line", () => {
		const turns: ChatTurn[] = [{
			role: "user",
			startedAt: 0,
			blocks: [
				{ type: "context_attachment", path: "Notes/foo.md", bytes: 2048, kind: "note" },
				{ type: "text", markdown: "Tell me about this note" },
			],
		}];
		const out = formatTranscriptAsMarkdown(mkRecord(turns));
		expect(out).toContain("📎 Attached note: `Notes/foo.md` (2.0 KB)");
		expect(out).toContain("Tell me about this note");
	});

	it("marks aborted turns in the heading", () => {
		const turns: ChatTurn[] = [{ role: "assistant", startedAt: 0, blocks: [{ type: "text", markdown: "stopped" }], aborted: true }];
		expect(formatTranscriptAsMarkdown(mkRecord(turns))).toMatch(/## Claude — .* \*\(aborted\)\*/);
	});

	it("output ends with a single trailing newline", () => {
		const out = formatTranscriptAsMarkdown(mkRecord([]));
		expect(out.endsWith("\n")).toBe(true);
		expect(out.endsWith("\n\n")).toBe(false);
	});

	it("does not emit invalid UTF-8 when truncating a multi-byte boundary", () => {
		// Each emoji is 4 bytes; cap mid-emoji to force boundary backup.
		const emoji = "🎉";
		const turns: ChatTurn[] = [{
			role: "assistant",
			startedAt: 0,
			blocks: [{ type: "tool", toolUseId: "t", tool: "Read", input: {}, status: "ok", output: emoji.repeat(50) }],
		}];
		const out = formatTranscriptAsMarkdown(mkRecord(turns), { toolOutputMaxBytes: 10 });
		expect(out).not.toContain("�");
	});
});

describe("slugifyForFilename", () => {
	it("strips path separators and forbidden characters", () => {
		expect(slugifyForFilename("foo/bar:baz?qux")).toBe("foo bar baz qux");
		expect(slugifyForFilename("a*b<c>d|e")).toBe("a b c d e");
		expect(slugifyForFilename('he said "hi"')).toBe("he said hi");
	});

	it("collapses internal whitespace runs", () => {
		expect(slugifyForFilename("a   b\t\tc")).toBe("a b c");
	});

	it("trims leading/trailing whitespace", () => {
		expect(slugifyForFilename("   foo   ")).toBe("foo");
	});

	it("falls back to 'Chat' when input is empty or all-whitespace", () => {
		expect(slugifyForFilename("")).toBe("Chat");
		expect(slugifyForFilename("   ")).toBe("Chat");
		expect(slugifyForFilename("///")).toBe("Chat");
	});

	it("caps length at 80 chars", () => {
		const long = "a".repeat(120);
		expect(slugifyForFilename(long).length).toBe(80);
	});

	it("reduces a Markdown link to its label", () => {
		expect(slugifyForFilename("read [SwiftUI tutorial](https://example.com/100)")).toBe("read SwiftUI tutorial");
	});

	it("strips bare URLs entirely", () => {
		expect(slugifyForFilename("Look at https://www.example.com/path now")).toBe("Look at now");
	});

	it("strips lingering bare 'http'/'https' tokens left after truncation", () => {
		expect(slugifyForFilename("foo https ww... bar")).toBe("foo ww... bar");
	});

	it("trims trailing punctuation/quote/paren/ellipsis noise", () => {
		expect(slugifyForFilename("Important note ...")).toBe("Important note");
		expect(slugifyForFilename("(Question?)")).toBe("Question");
		expect(slugifyForFilename("--- title ---")).toBe("title");
	});

	it("real-world: pasted URL + truncated tail produces a clean stem", () => {
		const messy = "https://www.hackingwithswift.com [www.hackingwithswift.com](https://www.hackingwithswift.com) 100 swiftui (https ww…";
		const got = slugifyForFilename(messy);
		expect(got).not.toContain("https");
		expect(got).not.toContain("[");
		expect(got).not.toContain("]");
		expect(got).not.toContain(":");
		expect(got).not.toContain("…");
		expect(got).toContain("100 swiftui");
	});

	it("falls back to 'Chat' if cleaning eats everything", () => {
		expect(slugifyForFilename("https://example.com")).toBe("Chat");
		expect(slugifyForFilename("[](http://x)")).toBe("Chat");
		expect(slugifyForFilename("...??...")).toBe("Chat");
	});
});

describe("defaultExportFilename", () => {
	it("produces a folder-relative path with title and YYYY-MM-DD", () => {
		const meta = mkMeta({ title: "My chat" });
		const path = defaultExportFilename(meta, new Date(2026, 4, 5, 14, 30).getTime());
		expect(path).toBe(`${DEFAULT_EXPORT_FOLDER}/My chat — 2026-05-05.md`);
	});

	it("respects a custom folder", () => {
		const meta = mkMeta({ title: "X" });
		expect(defaultExportFilename(meta, Date.UTC(2026, 0, 2), "Inbox/Claude")).toMatch(/^Inbox\/Claude\/X — 2026-01-/);
	});

	it("normalizes leading/trailing slashes in the folder", () => {
		const meta = mkMeta({ title: "X" });
		expect(defaultExportFilename(meta, Date.UTC(2026, 0, 2), "/foo/")).toMatch(/^foo\/X — /);
	});

	it("an empty folder argument writes to the vault root", () => {
		const meta = mkMeta({ title: "Y" });
		expect(defaultExportFilename(meta, Date.UTC(2026, 0, 2), "")).toMatch(/^Y — /);
	});

	it("zero-pads single-digit month and day", () => {
		const meta = mkMeta({ title: "Z" });
		const path = defaultExportFilename(meta, new Date(2026, 0, 3).getTime());
		expect(path).toContain("2026-01-03");
	});
});

describe("normalizeExportPath", () => {
	it("appends .md when the user omits an extension", () => {
		expect(normalizeExportPath("Notes/Chat")).toBe("Notes/Chat.md");
	});

	it("preserves an existing .md (case-insensitive)", () => {
		expect(normalizeExportPath("foo.MD")).toBe("foo.MD");
		expect(normalizeExportPath("foo.md")).toBe("foo.md");
	});

	it("strips a leading slash so the path is vault-relative", () => {
		expect(normalizeExportPath("/Inbox/foo")).toBe("Inbox/foo.md");
		expect(normalizeExportPath("///foo.md")).toBe("foo.md");
	});

	it("returns empty for whitespace-only or slash-only input", () => {
		expect(normalizeExportPath("")).toBe("");
		expect(normalizeExportPath("   ")).toBe("");
		expect(normalizeExportPath("///")).toBe("");
	});

	it("rejects pure-dot paths that would resolve to a directory", () => {
		expect(normalizeExportPath(".")).toBe("");
		expect(normalizeExportPath("..")).toBe("");
	});

	it("trims whitespace around the user's input", () => {
		expect(normalizeExportPath("  Notes/Chat.md  ")).toBe("Notes/Chat.md");
	});
});
