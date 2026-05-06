import type { BackendId, SessionId, TurnId, PermReqId } from "./ids";
import type {
	SessionMeta,
	PermissionGrants,
	AttachmentRef,
	PermissionDecision,
} from "../types";
import type { SessionRecord } from "../session/store";

export type StopReason =
	| "end_turn"
	| "tool_use"
	| "max_tokens"
	| "stop_sequence"
	| "content_filter"
	| "cancelled"
	| "error";

export type { PermissionDecision } from "../types";

export interface PermissionRule {
	tool: string;
	scope: "session" | "global";
	mode: "allow" | "deny";
}

export interface Capabilities {
	agentic: boolean;
	attachments: { image: boolean; file: boolean };
	resume: "native" | "replay";
	reasoning: boolean;
	reasoningSignature: boolean;
	mcp: boolean;
	slashCommands: boolean;
	hooks: boolean;
	subAgents: boolean;
	planMode: boolean;
	compaction: boolean;
	citations: boolean;
	cacheUsage: boolean;
	costTracking: boolean;
}

export interface ModelInfo {
	id: string;
	displayName: string;
	description?: string;
	contextTokens?: number;
	costUsdPerMTokIn?: number;
	costUsdPerMTokOut?: number;
}

export interface ToolInfo {
	name: string;
	displayName?: string;
	description?: string;
	risk?: "read" | "write" | "exec" | "network";
}

export type AuthStatus =
	| { state: "signed_out" }
	| { state: "signed_in"; account?: { email?: string; tier?: string } }
	| { state: "needs_api_key" }
	| { state: "error"; message: string };

export interface SignInOptions {
	method?: "subscription" | "oauth" | "api_key";
}

export interface Citation {
	title?: string;
	url?: string;
	startIdx?: number;
	endIdx?: number;
}

export type RichContent =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string }
	| { type: "file"; path: string };

export interface Attachment {
	mimeType: string;
	data: string;
	name?: string;
}

export interface ReasoningConfig {
	effort?: "low" | "medium" | "high";
	budgetTokens?: number;
}

export interface TurnOptions {
	model?: string;
	maxTokens?: number;
	systemPromptAddendum?: string;
	reasoning?: ReasoningConfig;
}

export interface SendTurnRequest {
	sessionId: SessionId;
	content: string | RichContent[];
	attachments?: Attachment[];
	options?: TurnOptions;
}

export interface SessionRef {
	id: SessionId;
	backendId: BackendId;
}

export type NormalizedErrorCode =
	| "session_not_found"
	| "auth_required"
	| "rate_limited"
	| "aborted"
	| "binary_missing"
	| "permission_denied"
	| "transport"
	| "unknown";

export interface NormalizedError {
	code: NormalizedErrorCode;
	message: string;
	raw?: unknown;
}

export type NormalizedEvent =
	| { type: "turn.started"; turnId: TurnId }
	| {
			type: "assistant.text.delta";
			messageId: string;
			text: string;
			citations?: Citation[];
	  }
	| { type: "assistant.text.done"; messageId: string; text: string }
	| { type: "assistant.reasoning.delta"; text: string }
	| { type: "assistant.reasoning.done"; text: string }
	| {
			type: "assistant.reasoning.signature";
			blockId: string;
			signature: string;
	  }
	| { type: "tool.call.requested"; id: string; name: string; input: unknown; mcpServer?: string }
	| { type: "tool.call.started"; id: string }
	| { type: "tool.call.partialResult"; id: string; chunk: string }
	| {
			type: "tool.call.completed";
			id: string;
			result?: string;
			error?: string;
	  }
	| {
			type: "tool.permission.requested";
			reqId: PermReqId;
			toolName: string;
			input: unknown;
			risk?: "read" | "write" | "exec" | "network";
	  }
	| { type: "subagent.started"; toolCallId: string; agentName: string }
	| { type: "subagent.completed"; toolCallId: string; agentName: string }
	| {
			type: "subagent.failed";
			toolCallId: string;
			agentName: string;
			error: string;
	  }
	| {
			type: "planMode.exitRequested";
			reqId: string;
			summary: string;
			planContent: string;
			actions: string[];
	  }
	| { type: "session.compaction.started" }
	| {
			type: "session.compaction.completed";
			preTokens: number;
			postTokens: number;
			summary?: string;
	  }
	| {
			type: "turn.usage";
			cumulative: true;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number;
			cacheCreationTokens?: number;
			costUsd?: number;
	  }
	| { type: "turn.completed"; stopReason: StopReason }
	| { type: "turn.failed"; error: NormalizedError };

export interface DiagnosticEvent {
	severity: "info" | "warn" | "error";
	source: "stderr" | "http" | "cli" | "plugin";
	message: string;
	raw?: string;
	ts: number;
}

export interface CreateSessionOptions {
	title?: string;
	cwd?: string;
	model?: string;
}

export interface Backend {
	id(): BackendId;
	capabilities(): Capabilities;
	availableModels(): Promise<ModelInfo[]>;

	isAvailable(): Promise<boolean>;
	version(): Promise<string>;
	install?(): Promise<void>;
	update?(): Promise<void>;

	authStatus(): Promise<AuthStatus>;
	signIn?(opts?: SignInOptions): Promise<void>;
	signOut?(): Promise<void>;
	setApiKey?(key: string): Promise<void>;
	clearApiKey?(): Promise<void>;

	createSession(opts: CreateSessionOptions): Promise<SessionRef>;
	listSessions(): Promise<SessionMeta[]>;
	getSession(id: SessionId): Promise<SessionRecord>;
	renameSession(id: SessionId, title: string): Promise<void>;
	deleteSession(id: SessionId): Promise<void>;

	sendTurn(req: SendTurnRequest): AsyncIterable<NormalizedEvent>;
	abortTurn(turnId: TurnId): Promise<void>;

	setModel(sessionId: SessionId, modelId: string): Promise<void>;
	setSystemPrompt?(sessionId: SessionId, text: string | null): Promise<void>;

	diagnostics(sessionId: SessionId): AsyncIterable<DiagnosticEvent>;

	hasNativeContext(sessionId: SessionId): Promise<boolean>;

	getNativeAdapter(): unknown;
}

export interface AgentBackend extends Backend {
	setCwd(sessionId: SessionId, path: string): Promise<void>;
	getCwd(sessionId: SessionId): Promise<string>;

	setPermissionPolicy(rule: PermissionRule): void;
	removePermissionPolicy(rule: PermissionRule): void;
	resolvePermission(reqId: PermReqId, decision: PermissionDecision): Promise<void>;

	availableTools(): Promise<ToolInfo[]>;
	discoverSlashCommands(sessionId: SessionId): Promise<SlashCommandInfo[]>;
}

export interface SlashCommandInfo {
	name: string;
	description?: string;
	argumentHint?: string;
	source: "project" | "user" | "builtin";
	path?: string;
}

export type { SessionMeta, SessionRecord, PermissionGrants, AttachmentRef };
