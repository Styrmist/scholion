import { describe, expect, it } from "vitest";
import {
	buildForkedTurns,
	freshForkMeta,
	makeForkTitle,
	serializeInheritedTurns,
} from "./forking";
import type { ChatTurn, SessionMeta } from "../types";

function userTurn(text: string): ChatTurn {
	return {
		role: "user",
		startedAt: 0,
		blocks: [{ type: "text", markdown: text }],
	};
}

function assistantTurn(text: string): ChatTurn {
	return {
		role: "assistant",
		startedAt: 0,
		blocks: [{ type: "text", markdown: text }],
	};
}

describe("buildForkedTurns", () => {
	it("returns empty when the parent has no turns", () => {
		expect(buildForkedTurns({ parentTurns: [], keepThroughIndex: 0 })).toEqual({
			turns: [],
			forkedFromTurns: 0,
		});
	});

	it("includes the kept index in the slice (inclusive)", () => {
		const turns = [userTurn("u1"), assistantTurn("a1"), userTurn("u2"), assistantTurn("a2")];
		const out = buildForkedTurns({ parentTurns: turns, keepThroughIndex: 1 });
		expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
		expect(out.forkedFromTurns).toBe(2);
	});

	it("clamps a too-large keepThroughIndex to the last available turn", () => {
		const turns = [userTurn("u1"), assistantTurn("a1")];
		const out = buildForkedTurns({ parentTurns: turns, keepThroughIndex: 99 });
		expect(out.forkedFromTurns).toBe(2);
	});

	it("clamps a negative keepThroughIndex to 0", () => {
		const turns = [userTurn("u1"), assistantTurn("a1")];
		const out = buildForkedTurns({ parentTurns: turns, keepThroughIndex: -5 });
		expect(out.forkedFromTurns).toBe(1);
	});

	it("deep-clones the slice so mutations don't leak across records", () => {
		const turns = [userTurn("u1"), assistantTurn("a1")];
		const out = buildForkedTurns({ parentTurns: turns, keepThroughIndex: 1 });
		// Mutate fork's first turn — original must stay intact.
		(out.turns[0]!.blocks[0] as { markdown: string }).markdown = "MUTATED";
		expect((turns[0]!.blocks[0] as { markdown: string }).markdown).toBe("u1");
	});
});

describe("serializeInheritedTurns", () => {
	it("emits empty string for no turns", () => {
		expect(serializeInheritedTurns([])).toBe("");
	});

	it("renders user / assistant alternation with role-specific tags", () => {
		const out = serializeInheritedTurns([userTurn("hi"), assistantTurn("hello")]);
		expect(out).toContain("<previous_user>\nhi\n</previous_user>");
		expect(out).toContain("<previous_assistant>\nhello\n</previous_assistant>");
		// Order preserved.
		expect(out.indexOf("previous_user")).toBeLessThan(out.indexOf("previous_assistant"));
	});

	it("collapses tool blocks into a one-line tool summary", () => {
		const turn: ChatTurn = {
			role: "assistant",
			startedAt: 0,
			blocks: [
				{ type: "text", markdown: "let me check" },
				{ type: "tool", toolUseId: "t1", tool: "Read", input: {}, status: "ok" },
				{ type: "text", markdown: "found it" },
			],
		};
		const out = serializeInheritedTurns([turn]);
		expect(out).toContain("[tool: Read (ok)]");
		// Both surrounding text segments are present.
		expect(out).toContain("let me check");
		expect(out).toContain("found it");
	});

	it("includes attachment markers in the user turn body", () => {
		const turn: ChatTurn = {
			role: "user",
			startedAt: 0,
			blocks: [
				{ type: "context_attachment", path: "n.md", bytes: 10, kind: "note" },
				{ type: "text", markdown: "see attached" },
			],
		};
		const out = serializeInheritedTurns([turn]);
		expect(out).toContain("[attached: note n.md]");
		expect(out).toContain("see attached");
	});

	it("skips empty turns (no text and no tool/attachment)", () => {
		const empty: ChatTurn = { role: "user", startedAt: 0, blocks: [] };
		const real = userTurn("kept");
		const out = serializeInheritedTurns([empty, real]);
		expect(out).toBe("<previous_user>\nkept\n</previous_user>");
	});

	it("truncates from the start when the body exceeds the byte cap", () => {
		const big = "x".repeat(200);
		const turns = Array.from({ length: 20 }, (_, i) => userTurn(big + i));
		const out = serializeInheritedTurns(turns, { maxBytes: 256 });
		expect(out.startsWith("<truncated_earlier_turns/>")).toBe(true);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThan(512);
	});
});

describe("makeForkTitle", () => {
	it("prepends 'Fork: ' to the parent title", () => {
		expect(makeForkTitle("Original chat")).toBe("Fork: Original chat");
	});

	it("uses 'Chat' as a fallback for empty / whitespace titles", () => {
		expect(makeForkTitle("")).toBe("Fork: Chat");
		expect(makeForkTitle("   ")).toBe("Fork: Chat");
	});

	it("ellipsizes when total length would exceed 60 chars", () => {
		const long = "x".repeat(80);
		const out = makeForkTitle(long);
		expect(out.length).toBeLessThanOrEqual(60);
		expect(out.startsWith("Fork: ")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("freshForkMeta", () => {
	const parent: SessionMeta = {
		localId: "parent",
		id: "claude-cli-id",
		title: "Original",
		createdAt: 1,
		updatedAt: 2,
		cwd: "/vault",
		model: "sonnet",
		lastTurnSummary: "summary",
	};

	it("strips the parent's CLI session id", () => {
		const out = freshForkMeta(parent, "child", 100);
		expect(out.id).toBeUndefined();
	});

	it("inherits cwd and model from the parent", () => {
		const out = freshForkMeta(parent, "child", 100);
		expect(out.cwd).toBe(parent.cwd);
		expect(out.model).toBe(parent.model);
	});

	it("does not inherit lastTurnSummary (fresh metadata)", () => {
		const out = freshForkMeta(parent, "child", 100);
		expect(out.lastTurnSummary).toBeUndefined();
	});

	it("uses the supplied localId and timestamp", () => {
		const out = freshForkMeta(parent, "child-id", 555);
		expect(out.localId).toBe("child-id");
		expect(out.createdAt).toBe(555);
		expect(out.updatedAt).toBe(555);
	});

	it("derives the title via makeForkTitle", () => {
		const out = freshForkMeta(parent, "child", 100);
		expect(out.title).toBe("Fork: Original");
	});
});
