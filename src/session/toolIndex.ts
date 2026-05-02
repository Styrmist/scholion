import { ToolBlock, ToolStatus } from "../types";
import type { SessionRecord } from "./store";

export interface ToolBlockRef {
	turnIndex: number;
	blockIndex: number;
}

/**
 * Index of tool blocks by tool_use_id across an entire session record.
 * Replaces the linear walks in ChatView and TranscriptView, and fixes the
 * misnamed `findToolBlockGlobal` lookup which only walked the active turn.
 */
export class ToolIndex {
	private byId = new Map<string, ToolBlockRef>();

	rebuildFrom(record: SessionRecord): void {
		this.byId.clear();
		record.turns.forEach((turn, turnIndex) => {
			turn.blocks.forEach((block, blockIndex) => {
				if (block.type === "tool") {
					this.byId.set(block.toolUseId, { turnIndex, blockIndex });
				}
			});
		});
	}

	register(toolUseId: string, ref: ToolBlockRef): void {
		this.byId.set(toolUseId, ref);
	}

	unregister(toolUseId: string): void {
		this.byId.delete(toolUseId);
	}

	resolve(record: SessionRecord, toolUseId: string): ToolBlock | null {
		const ref = this.byId.get(toolUseId);
		if (!ref) return null;
		const block = record.turns[ref.turnIndex]?.blocks[ref.blockIndex];
		if (!block || block.type !== "tool" || block.toolUseId !== toolUseId) {
			// The record shape drifted from the index (e.g. mid-mutation race).
			// Fall back to a one-shot scan and refresh the entry.
			return this.recoverByScan(record, toolUseId);
		}
		return block;
	}

	setStatus(record: SessionRecord, toolUseId: string, status: ToolStatus): boolean {
		const block = this.resolve(record, toolUseId);
		if (!block) return false;
		block.status = status;
		return true;
	}

	applyResult(record: SessionRecord, toolUseId: string, output: string, isError: boolean): boolean {
		const block = this.resolve(record, toolUseId);
		if (!block) return false;
		block.status = isError ? "error" : "ok";
		block.output = output;
		block.isError = isError;
		return true;
	}

	remove(record: SessionRecord, toolUseId: string): boolean {
		const ref = this.byId.get(toolUseId);
		if (!ref) return false;
		const turn = record.turns[ref.turnIndex];
		if (!turn) {
			this.byId.delete(toolUseId);
			return false;
		}
		const block = turn.blocks[ref.blockIndex];
		if (block && block.type === "tool" && block.toolUseId === toolUseId) {
			turn.blocks.splice(ref.blockIndex, 1);
			this.byId.delete(toolUseId);
			this.shiftDownAfter(ref.turnIndex, ref.blockIndex);
			return true;
		}
		// Index pointed at the wrong block; fall back to a scan.
		this.byId.delete(toolUseId);
		const scanned = this.findRefByScan(record, toolUseId);
		if (!scanned) return false;
		const t = record.turns[scanned.turnIndex];
		if (!t) return false;
		t.blocks.splice(scanned.blockIndex, 1);
		this.shiftDownAfter(scanned.turnIndex, scanned.blockIndex);
		return true;
	}

	clear(): void {
		this.byId.clear();
	}

	private recoverByScan(record: SessionRecord, toolUseId: string): ToolBlock | null {
		const ref = this.findRefByScan(record, toolUseId);
		if (!ref) {
			this.byId.delete(toolUseId);
			return null;
		}
		this.byId.set(toolUseId, ref);
		const block = record.turns[ref.turnIndex]?.blocks[ref.blockIndex];
		return block && block.type === "tool" ? block : null;
	}

	private findRefByScan(record: SessionRecord, toolUseId: string): ToolBlockRef | null {
		for (let turnIndex = 0; turnIndex < record.turns.length; turnIndex++) {
			const turn = record.turns[turnIndex];
			if (!turn) continue;
			for (let blockIndex = 0; blockIndex < turn.blocks.length; blockIndex++) {
				const block = turn.blocks[blockIndex];
				if (block && block.type === "tool" && block.toolUseId === toolUseId) {
					return { turnIndex, blockIndex };
				}
			}
		}
		return null;
	}

	private shiftDownAfter(turnIndex: number, removedBlockIndex: number): void {
		for (const [id, ref] of this.byId) {
			if (ref.turnIndex === turnIndex && ref.blockIndex > removedBlockIndex) {
				this.byId.set(id, { turnIndex, blockIndex: ref.blockIndex - 1 });
			}
		}
	}
}
