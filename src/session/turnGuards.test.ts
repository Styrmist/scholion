import { describe, expect, it } from "vitest";
import {
	partitionQueueByTool,
	QueuedPermission,
	shouldBatchSameTool,
	shouldPauseForCycleCap,
} from "./turnGuards";

describe("partitionQueueByTool", () => {
	it("returns empty sides for an empty queue", () => {
		expect(partitionQueueByTool([], "Edit")).toEqual({ matching: [], remaining: [] });
	});

	it("partitions consecutive same-tool entries to matching", () => {
		const queue: QueuedPermission[] = [
			{ toolUseId: "e1", toolName: "Edit" },
			{ toolUseId: "e2", toolName: "Edit" },
		];
		const out = partitionQueueByTool(queue, "Edit");
		expect(out.matching).toEqual(["e1", "e2"]);
		expect(out.remaining).toEqual([]);
	});

	it("preserves non-matching entry order across interleaved batches", () => {
		const queue: QueuedPermission[] = [
			{ toolUseId: "b1", toolName: "Bash" },
			{ toolUseId: "e1", toolName: "Edit" },
			{ toolUseId: "b2", toolName: "Bash" },
			{ toolUseId: "e2", toolName: "Edit" },
		];
		const out = partitionQueueByTool(queue, "Edit");
		expect(out.matching).toEqual(["e1", "e2"]);
		expect(out.remaining).toEqual([
			{ toolUseId: "b1", toolName: "Bash" },
			{ toolUseId: "b2", toolName: "Bash" },
		]);
	});

	it("returns no matches when the tool is absent", () => {
		const queue: QueuedPermission[] = [
			{ toolUseId: "b1", toolName: "Bash" },
			{ toolUseId: "r1", toolName: "Read" },
		];
		const out = partitionQueueByTool(queue, "Edit");
		expect(out.matching).toEqual([]);
		expect(out.remaining).toEqual(queue);
	});

	it("matches case-sensitively (Edit ≠ edit)", () => {
		const queue: QueuedPermission[] = [{ toolUseId: "e1", toolName: "edit" }];
		expect(partitionQueueByTool(queue, "Edit")).toEqual({
			matching: [],
			remaining: queue,
		});
	});

	it("does not mutate the input queue", () => {
		const queue: QueuedPermission[] = [
			{ toolUseId: "e1", toolName: "Edit" },
			{ toolUseId: "b1", toolName: "Bash" },
		];
		const snapshot: QueuedPermission[] = JSON.parse(JSON.stringify(queue)) as QueuedPermission[];
		partitionQueueByTool(queue, "Edit");
		expect(queue).toEqual(snapshot);
	});
});

describe("shouldBatchSameTool", () => {
	it("merges when tool names match", () => {
		expect(shouldBatchSameTool("Edit", "Edit", false)).toBe(true);
	});

	it("does not merge when tool names differ", () => {
		expect(shouldBatchSameTool("Edit", "Bash", false)).toBe(false);
	});

	it("refuses to merge while a cycle-cap pause is held, even for same tool", () => {
		expect(shouldBatchSameTool("Edit", "Edit", true)).toBe(false);
	});

	it("matches case-sensitively", () => {
		expect(shouldBatchSameTool("Edit", "edit", false)).toBe(false);
	});
});

describe("shouldPauseForCycleCap", () => {
	it("returns false when the cap is 0 (disabled)", () => {
		expect(shouldPauseForCycleCap(1000, 0, false)).toBe(false);
	});

	it("treats negative caps as disabled", () => {
		expect(shouldPauseForCycleCap(50, -1, false)).toBe(false);
	});

	it("returns false when count is at the cap (the cap is inclusive)", () => {
		expect(shouldPauseForCycleCap(100, 100, false)).toBe(false);
	});

	it("returns false when count is below the cap", () => {
		expect(shouldPauseForCycleCap(99, 100, false)).toBe(false);
	});

	it("returns true on the first arrival past the cap", () => {
		expect(shouldPauseForCycleCap(101, 100, false)).toBe(true);
	});

	it("returns false when a pause is already held (avoids duplicate UI)", () => {
		expect(shouldPauseForCycleCap(101, 100, true)).toBe(false);
	});

	it("alreadyHeld takes precedence over the disabled-cap short-circuit", () => {
		// Even with the cap disabled, an already-held flag still results in false;
		// no behavioral surprise either way, but contract-locked here.
		expect(shouldPauseForCycleCap(101, 0, true)).toBe(false);
	});
});
