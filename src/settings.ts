import {
	DEFAULT_ALLOWED_TOOLS,
	DEFAULT_COST_HARD_CAP_USD,
	DEFAULT_COST_WARN_USD,
	DEFAULT_MAX_ATTACH_KB,
	DEFAULT_MAX_TOOL_CALLS_PER_TURN,
} from "./constants";
import { PermissionMode, SendMethod, SessionMeta } from "./types";

export interface PluginSettings {
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
	sessions: SessionMeta[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
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
	sessions: [],
};
