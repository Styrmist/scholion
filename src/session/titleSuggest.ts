/**
 * Pure helpers for the auto-titling subsystem: build the prompt sent to the
 * Haiku titling subprocess, and parse its `--output-format json` reply.
 *
 * The actual subprocess spawn lives in `src/cli/titleRunner.ts`; this module
 * stays Obsidian/Node-free so the prompt-shape and response-parsing
 * invariants are testable in isolation.
 */

import type { ChatTurn } from "../types";
import type { SessionRecord } from "./store";

/** Cap per-turn text fed into the titler. ~2 KB of each side keeps the
 * input small enough that Haiku's prompt cache reuses cleanly across most
 * sessions while leaving room for a real conversation. */
export const PER_TURN_TEXT_CAP = 2000;

/** System prompt appended via `--append-system-prompt` to the titler. Kept
 * tight to keep the prompt cache stable across calls. */
export const TITLE_SYSTEM_PROMPT = "Output the title only. No preamble, no explanation. 60 chars max.";

export interface TitleSuggestInput {
	firstUserText: string;
	firstAssistantText: string;
	perTurnTextCap?: number;
}

export function buildTitlePrompt(input: TitleSuggestInput): string {
	const cap = input.perTurnTextCap ?? PER_TURN_TEXT_CAP;
	const u = clip(input.firstUserText.trim(), cap);
	const a = clip(input.firstAssistantText.trim(), cap);
	return [
		"<conversation>",
		"<user>",
		u,
		"</user>",
		"<assistant>",
		a,
		"</assistant>",
		"</conversation>",
		"",
		"Output a 4-8 word title for this conversation that captures the user's question or topic. Plain text only — no quotes, no trailing period, no emoji. Maximum 60 characters.",
	].join("\n");
}

function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

export interface TitleResponseOk { ok: true; title: string; costUsd: number; }
export interface TitleResponseErr { ok: false; reason: string; }
export type TitleResponse = TitleResponseOk | TitleResponseErr;

/**
 * Parse the CLI's `--output-format json` stdout. The CLI may emit a
 * "Warning: ..." line before the JSON object (we saw this when MCP servers
 * are blocked by enterprise policy), so we look for the *last* JSON-like
 * line rather than parsing the whole blob.
 */
export function parseTitleResponse(stdout: string): TitleResponse {
	const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	let parsed: unknown = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (!line.startsWith("{")) continue;
		try {
			parsed = JSON.parse(line);
			break;
		} catch {
			// keep walking backward
		}
	}
	if (!parsed || typeof parsed !== "object") {
		return { ok: false, reason: "non-JSON stdout" };
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.is_error === true) {
		const msg = typeof obj.result === "string" ? obj.result : "CLI error";
		return { ok: false, reason: msg };
	}
	const result = typeof obj.result === "string" ? obj.result : "";
	if (!result.trim()) {
		return { ok: false, reason: "empty result" };
	}
	const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
	return { ok: true, title: result, costUsd: cost };
}

/**
 * Pull the first user-message text and first assistant-text reply from a
 * record. Returns null if either is missing — the caller should skip
 * titling rather than fire a malformed prompt.
 */
export function extractFirstExchange(record: SessionRecord): { user: string; assistant: string } | null {
	const userTurn = record.turns.find((t) => t.role === "user");
	const assistantTurn = record.turns.find((t) => t.role === "assistant");
	if (!userTurn || !assistantTurn) return null;
	const user = collectText(userTurn);
	const assistant = collectText(assistantTurn);
	if (!user.trim() || !assistant.trim()) return null;
	return { user, assistant };
}

function collectText(turn: ChatTurn): string {
	const parts: string[] = [];
	for (const block of turn.blocks) {
		if (block.type === "text") parts.push(block.markdown);
	}
	return parts.join("\n").trim();
}
