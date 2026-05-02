export const VIEW_TYPE_CHAT = "claude-code-chat";

export const PLUGIN_DIR_BIN = "bin";
export const PLUGIN_DIR_CONFIG = "config";
export const PLUGIN_DIR_SESSIONS = "sessions";
export const PLUGIN_DIR_TMP = "tmp";

export const BINARY_NAME_UNIX = "claude";
export const BINARY_NAME_WINDOWS = "claude.exe";
export const INSTALLED_RECORD_FILE = "installed.json";
export const PARTIAL_DOWNLOAD_FILE = ".claude.partial";
export const PREVIOUS_BINARY_FILE_UNIX = "claude.prev";
export const PREVIOUS_BINARY_FILE_WINDOWS = "claude.prev.exe";

export const DOWNLOADS_BASE = "https://downloads.claude.ai/claude-code-releases";

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"] as const;

export function buildSafetyDenyRules(configDir: string): Array<
	{ tool: string; path: string } | { tool: string; command: string }
> {
	// Normalize Windows separators first so the literal-escape pass below sees
	// only forward slashes (no `\` to confuse the glob escaper).
	const normalized = configDir.replace(/\\/g, "/");
	const safe = escapeGlobMetaChars(normalized);
	return [
		{ tool: "Read", path: `./${safe}/**` },
		{ tool: "Edit", path: `./${safe}/**` },
		{ tool: "Write", path: `./${safe}/**` },
		{ tool: "Bash", command: `*${safe}*` },
	];
}

// Wrap each glob meta char in a character class so it matches literally.
// Without this, a vault path containing `*`, `?`, `[`, `]`, or `\` would
// silently turn the deny rule into something that doesn't match the
// plugin's config dir — leaving credentials unprotected.
function escapeGlobMetaChars(s: string): string {
	return s.replace(/[*?[\]\\]/g, "[$&]");
}

export const PERMISSION_DENIAL_PATTERNS = [
	/permission denied/i,
	/not allowed/i,
	/requires approval/i,
	/blocked by permission/i,
	/user denied/i,
];

export const STDOUT_OAUTH_URL_PATTERN = /https?:\/\/(?:claude\.ai|claude\.com|console\.anthropic\.com|platform\.claude\.com)[^\s"'<>]+/i;

export const ABORT_GRACE_MS = 1500;
export const STREAM_RENDER_DEBOUNCE_MS = 60;
export const SESSION_SAVE_DEBOUNCE_MS = 500;
export const TOOL_OUTPUT_PREVIEW_BYTES = 4096;
export const PARTIAL_STALE_AGE_MS = 60_000;
export const MAX_DIAGNOSTICS_PER_SESSION = 500;

export const DEFAULT_MAX_ATTACH_KB = 64;

export const RIBBON_ICON = "bot";
