import {
	DEFAULT_ALLOWED_TOOLS,
	DEFAULT_CONTEXT_WARN_PERCENT,
	DEFAULT_COST_HARD_CAP_USD,
	DEFAULT_COST_WARN_USD,
	DEFAULT_MAX_ATTACH_KB,
	DEFAULT_MAX_TOOL_CALLS_PER_TURN,
	DEFAULT_MODEL_CONTEXT_SIZE,
} from "./constants";
import type { BackendId } from "./backend/ids";
import { PermissionMode, SendMethod, SessionMeta } from "./types";

export interface PluginSettings {
	/**
	 * Backend that turns are dispatched to. Currently only `'claude-code'`
	 * is registered; the picker UI is hidden until a second backend ships.
	 * Persists silently so a future migration can flip it without prompting.
	 */
	defaultBackendId: BackendId;
	model: string;
	systemPromptAddendum: string;
	allowedTools: string[];
	disallowedTools: string[];
	permissionMode: PermissionMode;
	autoAttachActiveNote: boolean;
	preferSelection: boolean;
	maxAttachKB: number;
	sendMethod: SendMethod;
	checkUpdatesOnStartup: boolean;
	verboseLogging: boolean;
	/** USD; 0 disables the warning. Soft warn before the hard cap. */
	costWarnUsd: number;
	/** USD; 0 disables the cap. Blocks the next turn until the user explicitly bypasses it for the session. */
	costHardCapUsd: number;
	/** Per-turn cap on assistant `tool_use` events; 0 disables. Pauses the turn at the next hook-gated tool. */
	maxToolCallsPerTurn: number;
	/** When true, the composer offers `@`-mention autocomplete and resolves `@[[Name]]` references at send time. */
	enableMentions: boolean;
	/** When true, the composer offers slash-command autocomplete from `.claude/commands/` trees. */
	enableSlashCommands: boolean;
	/** Tokens. Total context window of the active model. 0 disables the context-warn check. */
	modelContextSize: number;
	/** Percent of the context window at which to fire a one-shot warning. 0 disables. */
	contextWarnPercent: number;
	sessions: SessionMeta[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
	defaultBackendId: "claude-code",
	model: "sonnet",
	systemPromptAddendum: "",
	allowedTools: [...DEFAULT_ALLOWED_TOOLS],
	disallowedTools: [],
	permissionMode: "default",
	autoAttachActiveNote: true,
	preferSelection: true,
	maxAttachKB: DEFAULT_MAX_ATTACH_KB,
	sendMethod: "enter",
	checkUpdatesOnStartup: true,
	verboseLogging: false,
	costWarnUsd: DEFAULT_COST_WARN_USD,
	costHardCapUsd: DEFAULT_COST_HARD_CAP_USD,
	maxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS_PER_TURN,
	enableMentions: true,
	enableSlashCommands: true,
	modelContextSize: DEFAULT_MODEL_CONTEXT_SIZE,
	contextWarnPercent: DEFAULT_CONTEXT_WARN_PERCENT,
	sessions: [],
};
