/**
 * Pure helpers that render a SessionRecord into a vault-ready Markdown
 * document. The output is human-oriented: it is meant to be read and
 * copy-pasted, not round-tripped back into a session. Tool outputs are
 * truncated at the same threshold the chat UI uses so an export of a long
 * tool-heavy session stays a sensible note size.
 *
 * This module is Obsidian-free so the formatting invariants stay testable.
 */

import { TOOL_OUTPUT_PREVIEW_BYTES } from "../constants";
import type { SessionRecord } from "./store";
import {
	ChatTurn,
	ContextAttachmentBlock,
	SessionMeta,
	SessionUsage,
	TextBlock,
	ToolBlock,
	ToolStatus,
} from "../types";
import { formatBytes, formatTokens } from "../utils/format";

export interface ExportOptions {
	/**
	 * Cap for any single tool output before we mark it truncated. Defaults to
	 * the same value the in-UI tool card uses (TOOL_OUTPUT_PREVIEW_BYTES).
	 */
	toolOutputMaxBytes?: number;
}

export const DEFAULT_EXPORT_FOLDER = "Claude Exports";

export function formatTranscriptAsMarkdown(record: SessionRecord, opts: ExportOptions = {}): string {
	const cap = opts.toolOutputMaxBytes ?? TOOL_OUTPUT_PREVIEW_BYTES;
	const sections: string[] = [];
	sections.push(renderHeader(record.meta, record.usage));
	for (const turn of record.turns) {
		sections.push(renderTurn(turn, cap));
	}
	return sections.join("\n\n").trim() + "\n";
}

/**
 * Build a vault-relative path for a fresh export. Caller is responsible for
 * disambiguating against existing files (e.g. by appending ` (2)` etc.) — we
 * only produce the canonical first-attempt name so the disambiguation logic
 * can stay UI-side where it has access to the vault adapter.
 */
export function defaultExportFilename(meta: SessionMeta, now: number, folder = DEFAULT_EXPORT_FOLDER): string {
	const date = new Date(now);
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	const slug = slugifyForFilename(meta.title || "Chat");
	const folderPart = folder.replace(/^\/+|\/+$/g, "");
	const stem = `${slug} — ${yyyy}-${mm}-${dd}`;
	return folderPart ? `${folderPart}/${stem}.md` : `${stem}.md`;
}

/**
 * Normalize a user-typed vault path into a writable .md path. Returns the
 * empty string when the input is unusable (empty, only whitespace, only
 * slashes, etc.) so the caller can show a single "pick a real path" Notice.
 * `.md` is appended if missing so the user doesn't have to remember it.
 */
export function normalizeExportPath(raw: string): string {
	const trimmed = raw.trim().replace(/^\/+/, "");
	if (!trimmed) return "";
	const withExt = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
	// Reject paths that are *only* slashes/dots — those would resolve to a
	// directory instead of a file inside the vault.
	if (/^\.+\.md$/i.test(withExt)) return "";
	return withExt;
}

/**
 * Strip path separators and characters Obsidian/Windows reject in filenames,
 * collapse whitespace, and trim to a sensible length. Empty results fall
 * back to "Chat" so the caller never has to special-case zero-length input.
 */
export function slugifyForFilename(s: string): string {
	const cleaned = s
		.replace(/[/\\:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "Chat";
	const max = 80;
	return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

function renderHeader(meta: SessionMeta, usage: SessionUsage | undefined): string {
	const lines: string[] = [];
	lines.push(`# ${meta.title || "Claude chat"}`);
	lines.push("");
	lines.push(`> **Created:** ${formatTimestamp(meta.createdAt)}`);
	lines.push(`> **Updated:** ${formatTimestamp(meta.updatedAt)}`);
	if (meta.cwd) lines.push(`> **Working directory:** \`${meta.cwd}\``);
	if (meta.model) lines.push(`> **Model:** \`${meta.model}\``);
	if (usage && (usage.totalCostUsd > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)) {
		lines.push(`> **Usage:** $${usage.totalCostUsd.toFixed(4)} · ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`);
	}
	lines.push("");
	lines.push("---");
	return lines.join("\n");
}

function renderTurn(turn: ChatTurn, toolOutputCap: number): string {
	const role = turn.role === "user" ? "You" : turn.role === "assistant" ? "Claude" : "System";
	const heading = `## ${role} — ${formatTimestamp(turn.startedAt)}${turn.aborted ? " *(aborted)*" : ""}`;
	const body = turn.blocks.map((b) => renderBlock(b, toolOutputCap)).filter((s) => s.length > 0).join("\n\n");
	return body ? `${heading}\n\n${body}` : heading;
}

function renderBlock(block: ChatTurn["blocks"][number], toolOutputCap: number): string {
	if (block.type === "text") return renderTextBlock(block);
	if (block.type === "tool") return renderToolBlock(block, toolOutputCap);
	return renderContextAttachmentBlock(block);
}

function renderTextBlock(block: TextBlock): string {
	return block.markdown.trim();
}

function renderContextAttachmentBlock(block: ContextAttachmentBlock): string {
	const kind = block.kind === "selection" ? "selection" : "note";
	return `> 📎 Attached ${kind}: \`${block.path}\` (${formatBytes(block.bytes)})`;
}

function renderToolBlock(block: ToolBlock, toolOutputCap: number): string {
	const status = renderStatus(block.status, block.isError);
	const lines: string[] = [];
	lines.push(`### 🔧 ${block.tool} — ${status}`);
	const inputJson = stringifyInput(block.input);
	if (inputJson) {
		lines.push("");
		lines.push("**Input:**");
		lines.push("```json");
		lines.push(inputJson);
		lines.push("```");
	}
	if (block.output !== undefined && block.output.length > 0) {
		const truncated = truncateUtf8(block.output, toolOutputCap);
		lines.push("");
		lines.push(truncated.didTruncate
			? `**Output** (truncated to ${formatBytes(toolOutputCap)} of ${formatBytes(truncated.originalBytes)}):`
			: "**Output:**");
		lines.push(fenceWith(truncated.text));
	}
	return lines.join("\n");
}

function renderStatus(status: ToolStatus, isError: boolean | undefined): string {
	if (isError) return "❌ error";
	switch (status) {
		case "ok": return "✅ ok";
		case "error": return "❌ error";
		case "denied": return "🚫 denied";
		case "aborted": return "⏹ aborted";
		case "running": return "⏳ running";
		case "pending_permission": return "⏸ awaiting permission";
		default: return status;
	}
}

function stringifyInput(input: unknown): string {
	if (input === undefined || input === null) return "";
	try {
		const json = JSON.stringify(input, null, 2);
		return typeof json === "string" ? json : "";
	} catch {
		return "";
	}
}

/**
 * Pick a fence longer than any backtick run inside `body` so the wrapping
 * fence never collides with content (Markdown allows arbitrary-length
 * fences as long as the closer matches the opener).
 */
function fenceWith(body: string): string {
	const longestRun = (body.match(/`+/g) ?? []).reduce((a, m) => Math.max(a, m.length), 0);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}\n${body}\n${fence}`;
}

interface TruncateResult {
	text: string;
	didTruncate: boolean;
	originalBytes: number;
}

/**
 * UTF-8-safe truncation that backs up to a codepoint boundary so we never
 * emit a U+FFFD half-character mid-export. Mirrors the behavior the context
 * truncator landed in 0.4.1.
 */
function truncateUtf8(text: string, maxBytes: number): TruncateResult {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) {
		return { text, didTruncate: false, originalBytes: buf.length };
	}
	let cut = maxBytes;
	while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
	const trimmed = buf.subarray(0, cut).toString("utf8");
	return { text: `${trimmed}\n…`, didTruncate: true, originalBytes: buf.length };
}

function formatTimestamp(ms: number): string {
	if (!ms || !Number.isFinite(ms)) return "—";
	const d = new Date(ms);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
