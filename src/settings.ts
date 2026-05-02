import { DEFAULT_ALLOWED_TOOLS, DEFAULT_MAX_ATTACH_KB } from "./constants";
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
	sessions: [],
};
