/**
 * Pure logic for parsing and resolving `@[[NoteName]]` mentions in composer text.
 *
 * Parsing is independent of Obsidian: it returns the literal names the user
 * wrote, in document order, deduped. Resolution is parameterized by a lookup
 * callback so the caller (ChatView) supplies Obsidian's `metadataCache`
 * resolution while tests supply a fixture.
 */

/**
 * Match `@[[Anything inside the brackets]]`. The name body excludes `]` so a
 * runaway `]` inside the link can't escape and swallow the rest of the
 * paragraph. We deliberately allow leading whitespace and any preceding char
 * so `(see @[[A]])` and `text@[[A]]` both work — the `@[[` opener is
 * unambiguous enough on its own without lookbehind heuristics.
 */
export const MENTION_RE = /@\[\[([^\]]+)\]\]/g;

export interface ParsedMention {
	/** Name as written between the brackets, trimmed. May be a basename or a full path. */
	name: string;
	/** Index in the source text where the literal `@[[` started. Used by display logic. */
	startIndex: number;
}

/**
 * Extract `@[[...]]` references from user text, in document order, with
 * trimmed names. Empty / whitespace-only names are dropped. Duplicates keep
 * the first occurrence (so `@[[A]] ... @[[A]]` parses to one entry).
 */
export function parseMentions(text: string): ParsedMention[] {
	const seen = new Set<string>();
	const out: ParsedMention[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		const name = (match[1] ?? "").trim();
		if (!name) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		out.push({ name, startIndex: match.index ?? 0 });
	}
	return out;
}

/**
 * A mention may resolve to a real vault path or to nothing (typo, deleted note).
 * Unresolvable mentions are surfaced so the caller can skip them silently
 * without aborting the whole turn.
 */
export interface ResolvedMention {
	name: string;
	path: string | null;
}

export type ResolveMention = (name: string) => string | null;

/**
 * Resolve every parsed mention in document order using the supplied lookup.
 * Drops nothing — unresolved mentions stay in the result with `path: null` so
 * the caller can decide whether to log, warn, or skip.
 */
export function resolveMentions(
	mentions: ReadonlyArray<ParsedMention>,
	resolve: ResolveMention,
): ResolvedMention[] {
	return mentions.map((m) => ({ name: m.name, path: resolve(m.name) }));
}

/**
 * Inspect the cursor's surroundings and return the active mention query if
 * the user is currently typing one. Returns null otherwise.
 *
 * A mention starts at the most recent unescaped `@` before the cursor that
 * is NOT preceded by a word character (so `email@x` does not trigger). The
 * query is the substring between that `@` and the cursor; whitespace inside
 * the query disables the popup (the user has moved past the mention).
 *
 * The returned `triggerStart` is the index of the `@` itself — the caller
 * uses it to splice the replacement.
 */
export function detectMentionQuery(
	textBeforeCursor: string,
): { query: string; triggerStart: number } | null {
	// Walk back from the cursor, breaking on whitespace; if we hit `@` first
	// and the char before it is "valid", we're in a mention context.
	for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
		const ch = textBeforeCursor[i]!;
		if (ch === "@") {
			const prev = i > 0 ? textBeforeCursor[i - 1]! : "";
			// Word char before `@` → it's part of an email/handle, not a mention.
			if (prev && /[\w]/.test(prev)) return null;
			const query = textBeforeCursor.slice(i + 1);
			// Already-completed mention syntax (closing `]]` would be past cursor):
			// reject if the query already contains a `]` so we don't re-trigger
			// inside an existing wikilink.
			if (query.includes("]")) return null;
			return { query, triggerStart: i };
		}
		// Whitespace before `@` means there's no active mention.
		if (/\s/.test(ch)) return null;
	}
	return null;
}

/**
 * Rank candidate filenames against a query. Empty query returns the input
 * order (so the caller's recency ordering is preserved). Otherwise prefers:
 *   1. Case-insensitive prefix match on basename.
 *   2. Case-insensitive substring match on basename.
 *   3. Case-insensitive substring match on full path.
 *   4. No match — excluded entirely.
 */
export interface MentionCandidate {
	/** Basename without extension (display + insertion). */
	basename: string;
	/** Full vault-relative path. */
	path: string;
}

export function rankMentionCandidates(
	candidates: ReadonlyArray<MentionCandidate>,
	query: string,
	limit: number,
): MentionCandidate[] {
	if (!query) return candidates.slice(0, limit);
	const q = query.toLowerCase();
	const prefix: MentionCandidate[] = [];
	const baseSubstr: MentionCandidate[] = [];
	const pathSubstr: MentionCandidate[] = [];
	for (const c of candidates) {
		const base = c.basename.toLowerCase();
		const path = c.path.toLowerCase();
		if (base.startsWith(q)) prefix.push(c);
		else if (base.includes(q)) baseSubstr.push(c);
		else if (path.includes(q)) pathSubstr.push(c);
	}
	return [...prefix, ...baseSubstr, ...pathSubstr].slice(0, limit);
}
