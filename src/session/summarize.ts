import { ChatTurn } from "../types";
import type { SessionRecord } from "./store";

/**
 * Pull a short, single-line summary of the most recent assistant turn for
 * display in the session picker. Tries to end at a sentence boundary within
 * the first 140 characters; falls back to a hard cut + ellipsis.
 */
export function summarizeLastAssistantTurn(record: SessionRecord): string | undefined {
	for (let i = record.turns.length - 1; i >= 0; i--) {
		const turn: ChatTurn | undefined = record.turns[i];
		if (!turn || turn.role !== "assistant") continue;
		for (const block of turn.blocks) {
			if (block.type === "text" && block.markdown.trim()) {
				return summarizeText(block.markdown);
			}
		}
		return undefined;
	}
	return undefined;
}

/** Exposed for direct testing without a SessionRecord fixture. */
export function summarizeText(markdown: string): string {
	const flat = markdown.replace(/\s+/g, " ").trim();
	const sentenceMatch = flat.match(/^.{1,140}?[.!?](?:\s|$)/);
	const summary = sentenceMatch ? sentenceMatch[0].trim() : flat.slice(0, 140);
	return summary.length > 140 ? summary.slice(0, 139) + "…" : summary;
}
