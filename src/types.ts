export type ClaudePlatform =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-x64"
	| "linux-arm64"
	| "linux-x64-musl"
	| "linux-arm64-musl"
	| "win32-x64"
	| "win32-arm64";

export interface ManifestPlatformEntry {
	checksum: string;
	url?: string;
}

export interface ReleaseManifest {
	version: string;
	platforms: Record<string, ManifestPlatformEntry>;
}

export interface InstalledRecord {
	version: string;
	sha256: string;
	platform: ClaudePlatform;
	installedAt: number;
}

export interface SessionMeta {
	localId: string;
	id?: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	model?: string;
	lastTurnSummary?: string;
}

export interface AttachmentRef {
	path: string;
	contentHash: string;
	kind: "note" | "selection";
	range?: [number, number];
}

export interface PermissionGrants {
	allowedTools: string[];
	deniedTools: string[];
	lastAttached?: AttachmentRef;
}

export interface DiagnosticEntry {
	ts: number;
	kind: "stderr" | "api_retry";
	text: string;
}

export interface SessionUsage {
	totalCostUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

export type ToolStatus = "pending_permission" | "running" | "ok" | "error" | "denied" | "aborted";

export interface ToolBlock {
	type: "tool";
	toolUseId: string;
	tool: string;
	input: unknown;
	status: ToolStatus;
	output?: string;
	isError?: boolean;
}

export interface TextBlock {
	type: "text";
	markdown: string;
	messageId?: string;
}

export interface ContextAttachmentBlock {
	type: "context_attachment";
	path: string;
	bytes: number;
	kind: "note" | "selection";
}

export type TurnBlock = TextBlock | ToolBlock | ContextAttachmentBlock;

export interface ChatTurn {
	role: "user" | "assistant" | "system";
	blocks: TurnBlock[];
	startedAt: number;
	finishedAt?: number;
	aborted?: boolean;
}

export interface UsageInfo {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

export type StreamEvent =
	| { kind: "system_init"; sessionId: string; model?: string; tools?: string[] }
	| { kind: "assistant_text"; text: string; messageId: string }
	| { kind: "assistant_text_delta"; delta: string; messageId: string }
	| { kind: "tool_use"; id: string; name: string; input: unknown }
	| { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
	| {
			kind: "result";
			status: "success" | "error" | "aborted";
			subtype?: string;
			stopReason?: string;
			usage?: UsageInfo;
			totalCostUsd?: number;
			errors?: string[];
			permissionDenied?: { tool: string; reason: string };
	  }
	| { kind: "api_retry"; attempt: number; maxRetries: number; retryDelayMs: number; errorStatus: number | null }
	| { kind: "stderr"; line: string }
	| { kind: "unknown"; raw: unknown };

export interface SendOptions {
	prompt: string;
	cwd: string;
	binaryPath: string;
	configDir: string;
	resumeSessionId?: string;
	allowedTools: string[];
	disallowedTools: string[];
	permissionMode: PermissionMode;
	model?: string;
	systemPromptAddendum?: string;
	settingsJson: string;
	signal: AbortSignal;
	onEvent: (event: StreamEvent) => void;
}

export interface SendResult {
	exitCode: number | null;
	stderr: string;
}

export type PermissionMode = "default" | "acceptEdits" | "plan";

export type SendMethod = "enter" | "cmdEnter";

export type PermissionDecision = "once" | "session" | "global" | "deny";

export interface PendingPermission {
	toolUseId: string;
	tool: string;
	input: unknown;
	originalPrompt: string;
}
