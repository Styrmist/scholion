import { describe, expect, it } from "vitest";
import { ToolIndex } from "./toolIndex";
import { ChatTurn, ToolBlock } from "../types";
import { SessionRecord } from "./store";

function tool(toolUseId: string, name = "Read"): ToolBlock {
	return {
		type: "tool",
		toolUseId,
		tool: name,
		input: { x: 1 },
		status: "running",
	};
}

function turn(blocks: ChatTurn["blocks"]): ChatTurn {
	return { role: "assistant", blocks, startedAt: 0 };
}

function record(turns: ChatTurn[]): SessionRecord {
	return {
		meta: { localId: "l", title: "t", createdAt: 0, updatedAt: 0, cwd: "/" },
		turns,
		permissions: { allowedTools: [], deniedTools: [] },
	};
}

describe("ToolIndex.rebuildFrom", () => {
	it("indexes empty record without error", () => {
		const idx = new ToolIndex();
		idx.rebuildFrom(record([]));
		expect(idx.resolve(record([]), "x")).toBe(null);
	});

	it("indexes a single tool block", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.rebuildFrom(r);
		expect(idx.resolve(r, "a")).toBeTruthy();
	});

	it("indexes multiple tool blocks across turns and resolves each", () => {
		const idx = new ToolIndex();
		const r = record([
			turn([{ type: "text", markdown: "hi" }, tool("a"), tool("b")]),
			turn([tool("c")]),
		]);
		idx.rebuildFrom(r);
		expect(idx.resolve(r, "a")?.toolUseId).toBe("a");
		expect(idx.resolve(r, "b")?.toolUseId).toBe("b");
		expect(idx.resolve(r, "c")?.toolUseId).toBe("c");
	});

	it("re-indexes from scratch on each rebuild (drops removed entries)", () => {
		const idx = new ToolIndex();
		const r1 = record([turn([tool("a")])]);
		idx.rebuildFrom(r1);
		const r2 = record([turn([tool("b")])]);
		idx.rebuildFrom(r2);
		expect(idx.resolve(r2, "a")).toBe(null);
		expect(idx.resolve(r2, "b")?.toolUseId).toBe("b");
	});
});

describe("register / unregister / resolve", () => {
	it("manual register makes resolve hit", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.register("a", { turnIndex: 0, blockIndex: 0 });
		expect(idx.resolve(r, "a")?.toolUseId).toBe("a");
	});

	it("unregister hides the entry from resolve (no fallback scan when fully missing)", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.register("a", { turnIndex: 0, blockIndex: 0 });
		idx.unregister("a");
		// Resolve only falls back to scan when the indexed ref is *stale*, not
		// when there's no entry at all. By design: callers that unregister are
		// asserting the block should not be addressable until reindexed.
		expect(idx.resolve(r, "a")).toBe(null);
	});

	it("resolve returns null when neither index nor record contains the id", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.rebuildFrom(r);
		expect(idx.resolve(r, "missing")).toBe(null);
	});

	it("resolve recovers when index points at the wrong block", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a"), tool("b")])]);
		idx.rebuildFrom(r);
		// Manually corrupt the index: "a" now points to block 1 (which is "b").
		idx.register("a", { turnIndex: 0, blockIndex: 1 });
		const out = idx.resolve(r, "a");
		expect(out?.toolUseId).toBe("a"); // recovered via scan
	});
});

describe("setStatus / applyResult", () => {
	it("setStatus mutates the resolved block", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.rebuildFrom(r);
		expect(idx.setStatus(r, "a", "ok")).toBe(true);
		expect(r.turns[0]!.blocks[0]).toMatchObject({ status: "ok" });
	});

	it("setStatus returns false when the id is unknown", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.rebuildFrom(r);
		expect(idx.setStatus(r, "missing", "ok")).toBe(false);
	});

	it("applyResult sets output, isError, and ok/error status", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.rebuildFrom(r);
		expect(idx.applyResult(r, "a", "result text", false)).toBe(true);
		expect(r.turns[0]!.blocks[0]).toMatchObject({
			status: "ok",
			output: "result text",
			isError: false,
		});

		idx.applyResult(r, "a", "boom", true);
		expect(r.turns[0]!.blocks[0]).toMatchObject({ status: "error", isError: true });
	});
});

describe("remove", () => {
	it("removes the block, drops the index entry, and shifts subsequent blocks down", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a"), tool("b"), tool("c")])]);
		idx.rebuildFrom(r);
		expect(idx.remove(r, "b")).toBe(true);
		expect(r.turns[0]!.blocks.map((b) => (b as ToolBlock).toolUseId)).toEqual(["a", "c"]);
		expect(idx.resolve(r, "b")).toBe(null);
		// "c" should now resolve to the new index 1 — verify by mutating via the index.
		idx.setStatus(r, "c", "ok");
		expect(r.turns[0]!.blocks[1]).toMatchObject({ toolUseId: "c", status: "ok" });
	});

	it("does not shift indexes in unrelated turns", () => {
		const idx = new ToolIndex();
		const r = record([
			turn([tool("a"), tool("b")]),
			turn([tool("c")]),
		]);
		idx.rebuildFrom(r);
		idx.remove(r, "a");
		// Mutating "c" via the index should still hit the right block in turn 1.
		idx.setStatus(r, "c", "ok");
		expect(r.turns[1]!.blocks[0]).toMatchObject({ toolUseId: "c", status: "ok" });
	});

	it("returns false for an unknown id", () => {
		const idx = new ToolIndex();
		const r = record([turn([tool("a")])]);
		idx.rebuildFrom(r);
		expect(idx.remove(r, "missing")).toBe(false);
	});
});
