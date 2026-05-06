/**
 * Pure logic for slash-command discovery and composer integration.
 *
 * Slash commands are markdown templates living under `.claude/commands/`
 * that the Claude CLI expands into a prompt body when the user starts a
 * message with `/<name>`. The CLI handles the expansion server-side; the
 * plugin's job is purely UX — let the user discover and insert them.
 *
 * Discovery scopes (mirrors the CLI):
 *   - project: `<cwd>/.claude/commands/**` (vault root in our case)
 *   - user:    `~/.claude/commands/**`
 *
 * Filename → command name. Subdirectories form `namespace:command` paths
 * (so `<scope>/.claude/commands/git/review.md` becomes `git:review`).
 *
 * This module is Obsidian/Node-free. The directory walk lives in
 * `slashCommandsFs.ts` and consumes the pure parser here.
 */

export type SlashCommandSource = "project" | "user" | "builtin";

export interface SlashCommand {
	/** Command name without the leading slash. May be `namespace:name`. */
	name: string;
	/** One-line description from frontmatter (optional). */
	description?: string;
	/** `argument-hint` from frontmatter, e.g. `[issue-number]` (optional). */
	argumentHint?: string;
	/** Where the command was discovered. Determines the trailing badge in the popup. */
	source: SlashCommandSource;
	/** Vault- or home-relative path the file came from, for sorting/dedup. */
	path: string;
}

export interface ParsedFrontmatter {
	description?: string;
	argumentHint?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse the optional YAML-ish frontmatter at the top of a command file. We
 * don't pull in a YAML parser — only `description` and `argument-hint` are
 * meaningful, and both are simple `key: value` pairs in practice. Anything
 * fancier (multi-line, lists, nested keys) is ignored, which is the right
 * tradeoff for a tiny dependency-free helper.
 */
export function parseCommandFrontmatter(content: string): ParsedFrontmatter {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return {};
	const body = match[1] ?? "";
	const out: ParsedFrontmatter = {};
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		// Strip surrounding straight quotes (back-reference matches same char).
		const straight = value.match(/^(["'`])(.*)\1$/);
		if (straight) value = straight[2] ?? "";
		// Strip paired curly quotes (open ≠ close, hence separate cases).
		else if (/^[“](.*)[”]$/.test(value)) value = value.slice(1, -1);
		else if (/^[‘](.*)[’]$/.test(value)) value = value.slice(1, -1);
		if (!value) continue;
		if (key === "description") out.description = value;
		else if (key === "argument-hint" || key === "argumenthint") out.argumentHint = value;
	}
	return out;
}

/**
 * Strip the frontmatter block from a command body so the caller can reason
 * about the actual prompt template separately. Used by tests to confirm
 * round-trip behavior — the CLI itself does its own expansion.
 */
export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_RE, "");
}

/**
 * Inspect the cursor's surroundings and return the active slash-command
 * query if the user is typing one. Returns null otherwise.
 *
 * A slash-command must start at column 0 of its line — i.e. the `/` is
 * the first character of the message or the first character after a
 * newline. This avoids false-positive triggers on regex syntax, file
 * paths, dates, or fractions inside a message body.
 *
 * Whitespace inside the query closes the popup so the user can type
 * arguments after the command name without the popup re-triggering.
 */
export function detectSlashQuery(
	textBeforeCursor: string,
): { query: string; triggerStart: number } | null {
	// Find the start of the current "line" — last newline before cursor + 1, or 0.
	const lastNl = textBeforeCursor.lastIndexOf("\n");
	const lineStart = lastNl < 0 ? 0 : lastNl + 1;
	if (textBeforeCursor[lineStart] !== "/") return null;
	const query = textBeforeCursor.slice(lineStart + 1);
	if (/\s/.test(query)) return null;
	// Reject paths / regex starting with `/`: bail if any non-name char shows up.
	// Allowed: alphanum, hyphen, underscore, colon (namespace separator).
	if (/[^A-Za-z0-9_\-:]/.test(query)) return null;
	return { query, triggerStart: lineStart };
}

/**
 * Rank candidate commands against a query. Empty query returns the
 * candidates in their input order so the caller's source ordering
 * (project before user, or alphabetical) is preserved.
 *
 * Otherwise prefers, in order:
 *   1. Case-insensitive prefix match on name.
 *   2. Case-insensitive substring match on name.
 *   3. Case-insensitive substring match on description.
 *   4. No match — excluded.
 */
export function rankCommands(
	candidates: ReadonlyArray<SlashCommand>,
	query: string,
	limit: number,
): SlashCommand[] {
	if (!query) return candidates.slice(0, limit);
	const q = query.toLowerCase();
	const prefix: SlashCommand[] = [];
	const nameSubstr: SlashCommand[] = [];
	const descSubstr: SlashCommand[] = [];
	for (const c of candidates) {
		const name = c.name.toLowerCase();
		if (name.startsWith(q)) prefix.push(c);
		else if (name.includes(q)) nameSubstr.push(c);
		else if (c.description && c.description.toLowerCase().includes(q)) descSubstr.push(c);
	}
	return [...prefix, ...nameSubstr, ...descSubstr].slice(0, limit);
}

/**
 * Build a command name from a vault-relative path inside a `.claude/commands/`
 * tree. Drops the `.md` extension and joins subdirectories with `:` so a
 * file at `git/review.md` becomes `git:review`. Empty/invalid input returns
 * an empty string so the caller can skip it.
 */
export function commandNameFromPath(relativePath: string): string {
	const trimmed = relativePath.replace(/^[/\\]+/, "");
	const sansExt = trimmed.replace(/\.md$/i, "");
	if (!sansExt) return "";
	return sansExt.split(/[/\\]+/).filter(Boolean).join(":");
}

/**
 * Curated list of CLI built-in slash commands that work in `-p` mode (the
 * mode the plugin uses). Verified empirically against CLI 2.1.126:
 *
 *   - `/cost`     returns subscription/usage info
 *   - `/clear`    clears active session (--resume context)
 *   - `/compact`  compacts conversation history (--resume context)
 *   - `/init`     initializes CLAUDE.md (works inside a project root)
 *   - `/review`   reviews the current diff (needs a git context)
 *
 * Most other built-ins (`/model`, `/agents`, `/skills`, `/settings`,
 * `/login`, `/plugin`, `/mcp`, etc.) report "isn't available in this
 * environment" under `-p` and are deliberately omitted — surfacing them
 * would just disappoint. Re-test against newer CLI versions when bumping
 * the bundled binary.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<SlashCommand> = [
	{ name: "cost", description: "Show subscription / usage info", source: "builtin", path: "<builtin>" },
	{ name: "compact", description: "Compact the conversation to free context (active session)", source: "builtin", path: "<builtin>" },
	{ name: "clear", description: "Clear the active session (or use 'New chat' in the picker)", source: "builtin", path: "<builtin>" },
	{ name: "init", description: "Initialize a CLAUDE.md for the current project", source: "builtin", path: "<builtin>" },
	{ name: "review", description: "Review the current diff (requires a git repository)", source: "builtin", path: "<builtin>" },
];

/**
 * Return the command name (no leading slash) if the message is a slash-command
 * invocation matching one of `knownNames`, else null. Used by the chat
 * pipeline to decide whether to bypass the `<user_message>` prompt wrapper —
 * the CLI only intercepts slash commands when the message starts with
 * `/<name>` literally, so wrapping kills interception.
 *
 * Matching only against *known* names (built-ins + discovered) keeps a typo
 * like `/randmm` from accidentally skipping the wrapping; in that case the
 * popup wouldn't have offered the command anyway, so the user clearly
 * intended a regular message starting with a slash.
 */
export function isKnownSlashCommandInvocation(
	text: string,
	knownNames: ReadonlySet<string>,
): string | null {
	const match = text.match(/^\/([A-Za-z0-9_\-:]+)(?:\s|$)/);
	if (!match) return null;
	const name = match[1] ?? "";
	if (!name || !knownNames.has(name)) return null;
	return name;
}

/**
 * Merge filesystem-discovered commands with the curated built-in list.
 * Project/user commands shadow built-ins on name collision so a user can
 * override e.g. `/review` with their own template. Filesystem ordering is
 * preserved; built-ins are appended in their declared order at the end.
 */
export function mergeWithBuiltins(
	fsCommands: ReadonlyArray<SlashCommand>,
	builtins: ReadonlyArray<SlashCommand> = BUILTIN_COMMANDS,
): SlashCommand[] {
	const seen = new Set<string>();
	const out: SlashCommand[] = [];
	for (const cmd of fsCommands) {
		if (seen.has(cmd.name)) continue;
		seen.add(cmd.name);
		out.push(cmd);
	}
	for (const cmd of builtins) {
		if (seen.has(cmd.name)) continue;
		seen.add(cmd.name);
		out.push(cmd);
	}
	return out;
}
