import type { AgentBackend } from "../backend/types";
import type {
	McpCapable,
	HooksCapable,
	SubAgentCapable,
	PlanModeCapable,
	ReasoningSignatureCapable,
	CompactionCapable,
} from "../backend/capabilities";

// Composite type the ClaudeCodeBackend implements. Lives in the provider so
// src/backend/ stays generic — adding a new provider with a different mix
// of capabilities means defining its own composite alongside its class.
export type ClaudeFullSurface = AgentBackend &
	McpCapable &
	HooksCapable &
	SubAgentCapable &
	PlanModeCapable &
	ReasoningSignatureCapable &
	CompactionCapable;
