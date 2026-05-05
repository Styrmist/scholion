export const VIEW_TYPE_CHAT = "claude-code-chat";

export const PLUGIN_DIR_BIN = "bin";
export const PLUGIN_DIR_CONFIG = "config";
export const PLUGIN_DIR_SESSIONS = "sessions";

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
export function escapeGlobMetaChars(s: string): string {
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

// Hook IPC: the hook script's inner timeout MUST be smaller than the CLI's outer
// timeout, because the CLI fails OPEN on its timeout (would silently allow the
// tool). The script's inner timeout fails DENY — that's the safe default if the
// user doesn't respond.
export const HOOK_SCRIPT_FILE_UNIX = "permissionHook.sh";
export const HOOK_SCRIPT_FILE_WINDOWS = "permissionHook.ps1";
export const HOOK_INNER_TIMEOUT_MS = 5 * 60_000;
export const HOOK_OUTER_TIMEOUT_SEC = 600;
export const HOOK_REQ_PREFIX = "hook-";
export const HOOK_REQ_SUFFIX = ".req";
export const HOOK_RESP_SUFFIX = ".resp";
// IPC dir lives in system temp (per-vault subdir, sha256-hashed). Keeping it
// outside the vault avoids iCloud/cloud-sync interference with the atomic
// .tmp→.req rename: parallel writes were producing 11/12 ENOENT-on-read on
// iCloud-synced vaults. See Hook IPC follow-ups in TODO.md.
export const HOOK_IPC_DIR_PREFIX = "obsidian-claude-code-";

export const DEFAULT_MAX_ATTACH_KB = 64;

// Safety / cost caps. 0 means "disabled".
// Cost caps default off — many users are on Claude.ai subscription where
// per-session $-cap thresholds don't translate cleanly. Users on metered API
// can opt in via settings.
export const DEFAULT_COST_WARN_USD = 0;
export const DEFAULT_COST_HARD_CAP_USD = 0;
// Tool-call cap defaults active. 100 is well above any single coherent task
// and well below the runaway-loop danger zone; users can lower it or set 0.
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 100;

// Context-window warning. Defaults match Anthropic's 200K window that all
// current Claude 4.x models share. Users on the 1M extended window can
// raise the size; the percent is a soft warn point.
export const DEFAULT_MODEL_CONTEXT_SIZE = 200_000;
export const DEFAULT_CONTEXT_WARN_PERCENT = 80;

export const RIBBON_ICON = "bot";
