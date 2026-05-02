/** Monotonic, opaque counter used to invalidate stale turn callbacks across awaits. */
export type TurnLease = number;

export interface PendingPermissionState {
	/** The tool's tool_use_id; used for both card identification and HookServer.respond. */
	placeholderToolUseId: string;
	tool: string;
	/** Always set in the current implementation; reserved for future correlation with stream hook events. */
	hookId: string;
}

/** Explicit state machine for an in-flight (or idle) turn. */
export type TurnState =
	| { kind: "idle" }
	| { kind: "starting"; lease: TurnLease }
	| { kind: "streaming"; lease: TurnLease; sawAssistantOutput: boolean }
	| { kind: "tool_running"; lease: TurnLease; toolName: string; sawAssistantOutput: boolean }
	| { kind: "awaiting_permission"; lease: TurnLease; pending: PendingPermissionState }
	| { kind: "aborting"; lease: TurnLease }
	| { kind: "error"; lease: TurnLease; message: string };

export type TurnStateKind = TurnState["kind"];

const ALLOWED_TRANSITIONS: Record<TurnStateKind, ReadonlyArray<TurnStateKind>> = {
	idle: ["starting"],
	starting: ["streaming", "tool_running", "awaiting_permission", "idle", "error"],
	streaming: ["streaming", "tool_running", "awaiting_permission", "idle", "error"],
	tool_running: ["streaming", "tool_running", "awaiting_permission", "idle", "error"],
	// Hook flow: same turn continues after the user decides — back to streaming
	// (CLI keeps emitting events). Legacy resend path goes via "starting".
	awaiting_permission: ["starting", "streaming", "tool_running", "idle", "aborting"],
	aborting: ["idle"],
	error: ["idle", "starting"],
};

export function canTransition(from: TurnStateKind, to: TurnStateKind): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}
