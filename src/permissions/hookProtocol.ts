import { HOOK_REQ_PREFIX, HOOK_REQ_SUFFIX, HOOK_RESP_SUFFIX } from "../constants";

/** Shape the CLI writes to the hook script's stdin. Verified live with claude 2.1.116. */
export interface HookRequest {
	session_id: string;
	transcript_path: string;
	cwd: string;
	permission_mode: string;
	hook_event_name: "PreToolUse";
	tool_name: string;
	tool_input: unknown;
	tool_use_id: string;
}

export type HookDecision = "allow" | "deny" | "ask" | "defer";

/** What the plugin writes to <tmpDir>/hook-<id>.resp; the hook script reads this. */
export interface HookResponseFile {
	decision: HookDecision;
	reason?: string;
}

export function reqFileName(toolUseId: string): string {
	return `${HOOK_REQ_PREFIX}${toolUseId}${HOOK_REQ_SUFFIX}`;
}

export function respFileName(toolUseId: string): string {
	return `${HOOK_REQ_PREFIX}${toolUseId}${HOOK_RESP_SUFFIX}`;
}

export function isReqFile(name: string): boolean {
	return name.startsWith(HOOK_REQ_PREFIX) && name.endsWith(HOOK_REQ_SUFFIX);
}

export function toolUseIdFromReqFile(name: string): string | null {
	if (!isReqFile(name)) return null;
	return name.slice(HOOK_REQ_PREFIX.length, name.length - HOOK_REQ_SUFFIX.length);
}
