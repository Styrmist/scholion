/**
 * Shared cleaning helpers for chat titles and export filename slugs. The
 * same source — the user's first message — feeds both, so the URL/markdown
 * stripping logic is consolidated here. Keep this module Obsidian-free so
 * the invariants stay testable.
 */

const TRIM_NOISE_CLASS = /^[\s.,;:!?…()\-—–"'`]+|[\s.,;:!?…()\-—–"'`]+$/g;

/**
 * Reduce common noise patterns:
 *  - `[label](url)` Markdown links collapse to `label`
 *  - `http[s]://...` URLs are removed entirely
 *  - bare `http`/`https` tokens left over from a truncated URL are removed
 *  - whitespace runs collapse to a single space
 *  - leading/trailing punctuation/quote/paren/ellipsis runs are trimmed
 */
export function stripNoise(s: string): string {
	let out = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	out = out.replace(/https?:\/\/\S+/gi, " ");
	out = out.replace(/\bhttps?\b/gi, " ");
	out = out.replace(/\s+/g, " ").trim();
	return trimPunctNoise(out);
}

/** Strip leading/trailing punctuation/whitespace runs only, leave the body alone. */
export function trimPunctNoise(s: string): string {
	return s.replace(TRIM_NOISE_CLASS, "");
}

/**
 * Build a fallback heuristic title from a raw user message. The title cap
 * is 60 chars (matches the original `makeTitle`); cleaning that eats the
 * whole message (e.g. the first message was just a URL) falls back to the
 * "New chat" placeholder so the picker has something readable to show.
 */
export function heuristicTitle(userText: string): string {
	const stripped = stripNoise(userText);
	if (!stripped) return "New chat";
	if (stripped.length <= 60) return stripped;
	return stripped.slice(0, 57).trimEnd() + "…";
}

/**
 * Clean a title produced by Haiku before storing it. Strips paired wrap
 * quotes the model sometimes adds, removes trailing punctuation, collapses
 * whitespace, caps at 60 chars. Returns the empty string when cleaning
 * leaves nothing — the caller should treat that as a generation failure
 * and fall back to the heuristic.
 */
export function cleanGeneratedTitle(raw: string): string {
	let s = raw.replace(/\s+/g, " ").trim();
	// Strip paired wrap quotes (straight + curly variants Claude sometimes uses).
	const wrapPair = /^(["'`“”‘’«»])(.+)\1$/;
	const m = s.match(wrapPair);
	if (m) s = m[2]!;
	// Common case where Claude opens with “ and closes with ” (mismatched but paired in Unicode).
	s = s.replace(/^[“](.+)[”]$/, "$1").replace(/^[‘](.+)[’]$/, "$1");
	s = trimPunctNoise(s);
	if (!s) return "";
	if (s.length > 60) s = s.slice(0, 57).trimEnd() + "…";
	return s;
}
