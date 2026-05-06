import type {
	Backend,
	AgentBackend,
	ReasoningConfig,
	NormalizedEvent,
} from "./types";
import type { SessionId } from "./ids";

export interface ReasoningCapable {
	setReasoningConfig?(sessionId: SessionId, cfg: ReasoningConfig): void;
}

export interface ReasoningSignatureCapable extends ReasoningCapable {
	verifyReasoningBlock(blockId: string, sig: string): boolean;
}

export interface McpServerInfo {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	transport: "stdio" | "http" | "sse";
	url?: string;
	/** Concise one-line summary suitable for UI display (e.g. command line or URL). */
	summary?: string;
	disabled?: boolean;
}

export interface McpServerSpec {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	transport: "stdio" | "http" | "sse";
	url?: string;
}

export interface McpCapable {
	listMcpServers(): Promise<McpServerInfo[]>;
	addMcpServer(spec: McpServerSpec): Promise<void>;
	removeMcpServer(name: string): Promise<void>;
}

export interface SubAgentInfo {
	name: string;
	description?: string;
	source?: "project" | "user" | "builtin";
}

export interface SubAgentCapable {
	listSubAgents?(): Promise<SubAgentInfo[]>;
}

export interface PlanModeCapable {
	setPlanMode(sessionId: SessionId, on: boolean): void;
	resolvePlanModeExit(
		reqId: string,
		decision: "approve" | "keepPlanning",
	): Promise<void>;
}

export interface HookConfig {
	commands: Record<string, string[]>;
}

export interface HooksCapable {
	getHookConfig(): Promise<HookConfig>;
	setHookConfig(cfg: HookConfig): Promise<void>;
}

export interface CompactionCapable {
	triggerCompaction?(sessionId: SessionId): Promise<void>;
}

export const isAgentBackend = (b: Backend): b is AgentBackend =>
	b.capabilities().agentic;

export const isReasoningCapable = (
	b: Backend,
): b is Backend & ReasoningCapable => b.capabilities().reasoning;

export const isReasoningSignatureCapable = (
	b: Backend,
): b is Backend & ReasoningSignatureCapable =>
	b.capabilities().reasoningSignature;

export const isMcpCapable = (b: Backend): b is Backend & McpCapable =>
	b.capabilities().mcp;

export const isSubAgentCapable = (
	b: Backend,
): b is Backend & SubAgentCapable => b.capabilities().subAgents;

export const isPlanModeCapable = (
	b: Backend,
): b is Backend & PlanModeCapable => b.capabilities().planMode;

export const isHooksCapable = (b: Backend): b is Backend & HooksCapable =>
	b.capabilities().hooks;

export const isCompactionCapable = (
	b: Backend,
): b is Backend & CompactionCapable => b.capabilities().compaction;

export type AnyCapabilityEvent = Extract<
	NormalizedEvent,
	{
		type:
			| "assistant.reasoning.delta"
			| "assistant.reasoning.done"
			| "assistant.reasoning.signature"
			| "subagent.started"
			| "subagent.completed"
			| "subagent.failed"
			| "planMode.exitRequested"
			| "session.compaction.started"
			| "session.compaction.completed";
	}
>;
