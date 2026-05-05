/**
 * Pure helpers for conversation forking.
 *
 * Forking takes a parent SessionRecord and produces a freshly-truncated
 * record-shape that the caller persists as a new session. The CLI session
 * id is dropped — the forked session is "fresh" from the CLI's perspective
 * and the inherited turns get re-sent on the first turn as a
 * `<previous_conversation>` block (built by the prompt builder).
 *
 * This module is Obsidian-free so the truncation invariants stay testable.
 */

import type { ChatTurn, SessionMeta } from "../types";

export interface ForkInput {
	parentTurns: ReadonlyArray<ChatTurn>;
	/** Turn index in `parentTurns` to keep through (inclusive). */
	keepThroughIndex: number;
}

export interface ForkResult {
	turns: ChatTurn[];
	forkedFromTurns: number;
}

/**
 * Slice the parent's turns so the result includes index 0 through
 * `keepThroughIndex` (inclusive). The slice is deep-cloned so subsequent
 * edits to the parent record don't bleed into the forked record (or
 * vice-versa). Out-of-range indices clamp to a safe value.
 */
export function buildForkedTurns(input: ForkInput): ForkResult {
	const lastIdx = input.parentTurns.length - 1;
	if (lastIdx < 0) {
		return { turns: [], forkedFromTurns: 0 };
	}
	const clamped = Math.max(0, Math.min(input.keepThroughIndex, lastIdx));
	const slice = input.parentTurns.slice(0, clamped + 1);
	return {
		turns: deepCloneTurns(slice),
		forkedFromTurns: slice.length,
	};
}

/**
 * Render inherited turns as a serialized text block to feed into Claude as
 * the first turn's `<previous_conversation>` context. Tool blocks are
 * collapsed into a one-line summary; the goal is to give Claude enough
 * shape to know what was discussed without spending the entire context on
 * tool I/O that already happened.
 */
export function serializeInheritedTurns(
	turns: ReadonlyArray<ChatTurn>,
	opts: { maxBytes?: number } = {},
): string {
	const maxBytes = opts.maxBytes ?? 64 * 1024;
	const lines: string[] = [];
	for (const turn of turns) {
		if (turn.role === "user") {
			const text = collectText(turn);
			if (text) lines.push(`<previous_user>\n${text}\n</previous_user>`);
		} else if (turn.role === "assistant") {
			const parts: string[] = [];
			for (const block of turn.blocks) {
				if (block.type === "text") parts.push(block.markdown);
				else if (block.type === "tool") parts.push(`[tool: ${block.tool} (${block.status})]`);
			}
			const body = parts.join("\n").trim();
			if (body) lines.push(`<previous_assistant>\n${body}\n</previous_assistant>`);
		}
	}
	let out = lines.join("\n\n");
	const buf = Buffer.from(out, "utf8");
	if (buf.length > maxBytes) {
		// Prefer truncating from the start: the most recent context is the
		// most relevant for continuing the conversation.
		const slice = buf.subarray(buf.length - maxBytes);
		// Walk forward to a UTF-8 codepoint boundary.
		let start = 0;
		while (start < slice.length && (slice[start]! & 0xc0) === 0x80) start++;
		out = `<truncated_earlier_turns/>\n${slice.subarray(start).toString("utf8")}`;
	}
	return out;
}

/**
 * Format a fork's title from a parent's title. Keeps under 60 chars and
 * marks the fork visibly so the picker can show its lineage.
 */
export function makeForkTitle(parentTitle: string): string {
	const trimmed = parentTitle.trim() || "Chat";
	const prefix = "Fork: ";
	const max = 60;
	if (prefix.length + trimmed.length <= max) return prefix + trimmed;
	return prefix + trimmed.slice(0, max - prefix.length - 1) + "…";
}

/** Resets the per-session counters that shouldn't carry into a fork. */
export function freshForkMeta(parentMeta: SessionMeta, localId: string, now: number): SessionMeta {
	return {
		localId,
		title: makeForkTitle(parentMeta.title),
		createdAt: now,
		updatedAt: now,
		cwd: parentMeta.cwd,
		// Note: `id` (CLI session id) is intentionally absent so the fork's
		// first turn starts a fresh CLI conversation.
		model: parentMeta.model,
	};
}

function collectText(turn: ChatTurn): string {
	const parts: string[] = [];
	for (const block of turn.blocks) {
		if (block.type === "text") parts.push(block.markdown);
		else if (block.type === "context_attachment") {
			parts.push(`[attached: ${block.kind} ${block.path}]`);
		}
	}
	return parts.join("\n").trim();
}

function deepCloneTurns(turns: ReadonlyArray<ChatTurn>): ChatTurn[] {
	// JSON round-trip is enough for our turn shape: all fields are plain data
	// (strings, numbers, booleans, arrays, plain objects). No Dates, Maps, or
	// class instances live in `ChatTurn`.
	return JSON.parse(JSON.stringify(turns)) as ChatTurn[];
}
