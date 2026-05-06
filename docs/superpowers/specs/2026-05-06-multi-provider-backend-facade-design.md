# Multi-provider backend facade — design

## Context

The plugin currently runs a single backend: Claude Code CLI as a subprocess (see [src/cli/runner.ts](../../../src/cli/runner.ts), [src/cli/events.ts](../../../src/cli/events.ts), [src/session/turnCoordinator.ts](../../../src/session/turnCoordinator.ts)). To support additional providers without churning the UI per-backend, the plugin needs an abstraction the UI sits on.

Five backends are in scope, spanning two capability tiers:

- **Agent CLIs (4):** Claude Code, Codex, Gemini, Copilot. Each wraps a local CLI subprocess; the CLI itself owns session/tool/permission machinery.
- **Chat-only HTTP (1):** Llama via Ollama / llama.cpp / OpenAI-compatible remote. No CLI; the plugin holds session state and replays history each turn.

The method surface is grouped four ways:

- **Group A — Common.** Every backend implements every method. The chat-only minimum.
- **Group B — Agent-only.** Lifted in by the four CLIs via `capabilities.agentic`.
- **Group C — Per-feature flags.** Individual capability flags; UI conditionally lights up chrome (MCP, plan mode, hooks, sub-agents, citations, …).
- **Group D — Native escape.** Provider-specific knobs the UI doesn't depend on.

Sketches are TypeScript because the plugin is TS. Type names like `SessionMeta`, `SessionRecord`, `AuthStatus`, `PermissionRule`, `Attachment`, `RichContent`, `NormalizedError`, `Citation`, `StopReason`, `ModelInfo`, `SubAgentInfo`, `McpServerSpec`, `HookConfig`, `ReasoningConfig`, `SignInOptions`, `TurnOptions`, `SlashCommand` are placeholders to be defined alongside the implementation. Treat the sketches as conceptual — final names and shapes will shift.

The research basis — a wire-level comparison of the streaming protocols underneath each provider — is preserved as Appendix A and informed every shape choice below (cumulative-snapshot usage, partial-JSON tool args, normalized stop reasons, the agent-only/chat-only split).

## Group A — Common (every backend)

```ts
type BackendId = 'claude-code' | 'codex' | 'gemini-cli' | 'copilot-cli' | 'llama-http';

type Capabilities = {
  agentic: boolean;
  attachments: { image: boolean; file: boolean };
  resume: 'native' | 'replay';            // CLI-side vs plugin-side message replay
  reasoning: boolean;
  reasoningSignature: boolean;            // Claude only
  mcp: boolean;
  slashCommands: boolean;
  hooks: boolean;
  subAgents: boolean;
  planMode: boolean;
  compaction: boolean;
  citations: boolean;
  cacheUsage: boolean;                    // Anthropic-style cache_read / cache_creation tokens
  costTracking: boolean;
};

interface Backend {
  // Identity & capability discovery
  id(): BackendId;
  capabilities(): Capabilities;
  availableModels(): Promise<ModelInfo[]>;

  // Health & install (no-op for HTTP backends)
  isAvailable(): Promise<boolean>;
  version(): Promise<string>;
  install?(): Promise<void>;
  update?(): Promise<void>;

  // Auth — exactly one path is wired per backend
  authStatus(): Promise<AuthStatus>;
  signIn?(opts?: SignInOptions): Promise<void>;     // subscription/OAuth (Claude, Codex, Gemini, Copilot)
  signOut?(): Promise<void>;
  setApiKey?(key: string): Promise<void>;           // Llama-HTTP, alt path for Codex/Gemini
  clearApiKey?(): Promise<void>;

  // Session CRUD — plugin-owned uniformly; CLIs additionally track a native session id
  createSession(opts: { title?: string; cwd?: string; model?: string }): Promise<SessionRef>;
  listSessions(): Promise<SessionMeta[]>;
  getSession(id: SessionId): Promise<SessionRecord>;
  renameSession(id: SessionId, title: string): Promise<void>;
  deleteSession(id: SessionId): Promise<void>;

  // The one hot path
  sendTurn(req: SendTurnRequest): AsyncIterable<NormalizedEvent>;
  abortTurn(turnId: TurnId): Promise<void>;

  // Per-session settings
  setModel(sessionId: SessionId, modelId: string): Promise<void>;
  setSystemPrompt?(sessionId: SessionId, text: string | null): Promise<void>;

  // Diagnostics — stderr (CLI) or HTTP error stream
  diagnostics(sessionId: SessionId): AsyncIterable<DiagnosticEvent>;

  // Native escape (Group D)
  getNativeAdapter(): unknown;
}

type SendTurnRequest = {
  sessionId: SessionId;
  content: string | RichContent[];
  attachments?: Attachment[];                // images always; files only if capability.attachments.file
  options?: TurnOptions;                     // per-turn overrides (model, max tokens, ...)
};

type NormalizedEvent =                       // see Group B / C for additional variants
  | { type: 'turn.started'; turnId: TurnId }
  | { type: 'assistant.text.delta'; text: string; citations?: Citation[] }
  | { type: 'assistant.text.done'; text: string }
  | { type: 'turn.usage'; cumulative: true; inputTokens: number; outputTokens: number;
      cacheReadTokens?: number; cacheCreationTokens?: number; costUsd?: number }
  | { type: 'turn.completed'; stopReason: StopReason }
  | { type: 'turn.failed'; error: NormalizedError };

type DiagnosticEvent = {
  severity: 'info' | 'warn' | 'error';
  source: 'stderr' | 'http' | 'cli' | 'plugin';
  message: string;                            // human-readable, normalized
  raw?: string;                               // original payload (stderr line, HTTP body, ...)
  ts: number;                                 // ms epoch
};
```

Notes on normalization choices:

- **`turn.usage` is cumulative-snapshot.** May be emitted multiple times during a turn; each emission is the running total. Generalizes Claude's per-`message_delta` cumulative usage, OpenAI Responses' final-only `response.completed.usage`, and Gemini's per-chunk `usageMetadata`. UI displays the latest snapshot.
- **`stopReason`** is normalized to `end_turn | tool_use | max_tokens | stop_sequence | content_filter | cancelled | error`. Per-backend mapping in implementation.
- **`resume`** is implicit: if the session has prior turns, `sendTurn` resumes. CLI backends pass `--resume <native_id>`; HTTP backends replay the persisted message list. The capability flag tells the UI which to expect (native = CLI process keeps its own context, replay = full history sent each turn).
- **A session is bound to one backend at creation.** `createSession` records the backend id; switching backends mid-conversation is not supported — the UI creates a new session instead. Avoids the impossible job of replaying a Claude Code transcript (with its native session id, hook IPC, MCP state) into Codex or Llama.
- **`DiagnosticEvent`** is normalized to `{ severity, source, message, raw?, ts }` so the UI's diagnostics panel ([src/ui/diagnosticsPanel.ts](../../../src/ui/diagnosticsPanel.ts)) renders uniformly across backends. `raw` is preserved for power-user inspection but never required by the UI.

## Group B — Agent-only additions (gated by `capabilities.agentic`)

```ts
interface AgentBackend extends Backend {
  // Working directory / repo context
  setCwd(sessionId: SessionId, path: string): Promise<void>;
  getCwd(sessionId: SessionId): Promise<string>;

  // Tool permission policy
  setPermissionPolicy(rule: PermissionRule): void;
  removePermissionPolicy(rule: PermissionRule): void;
  resolvePermission(reqId: PermReqId, decision: PermissionDecision): Promise<void>;
  // PermissionDecision: 'allowOnce' | 'allowSession' | 'allowAlways' | 'deny'

  // Slash command discovery (custom commands found on disk, plus CLI built-ins)
  discoverSlashCommands(sessionId: SessionId): Promise<SlashCommand[]>;
}

// Additional NormalizedEvent variants:
//   { type: 'tool.call.requested'; id; name; input }
//   { type: 'tool.call.started'; id }
//   { type: 'tool.call.partialResult'; id; chunk }
//   { type: 'tool.call.completed'; id; result?; error? }
//   { type: 'tool.permission.requested'; reqId; toolName; input; risk? }
```

Backed by all four CLIs. Llama-HTTP returns `capabilities.agentic = false` and the UI hides this surface entirely (no permission panel, no plan toggle, no slash palette).

Per-backend translation differs (this is implementation detail, not facade detail, but worth noting because it shaped the design):

- **`claude-code`:** `tool.permission.requested` is sourced from the existing CLI hook IPC ([src/permissions/hookServer.ts](../../../src/permissions/hookServer.ts)). A future `claude-sdk` backend (using `@anthropic-ai/claude-agent-sdk` directly) would source it from the SDK's `canUseTool` callback instead — same facade event either way.
- **`copilot-cli`:** maps directly from native `permission.requested` / `tool.execution_*` events.
- **`codex` / `gemini-cli`:** maps from each CLI's stream-JSON tool-call lifecycle.

## Group C — Per-feature capability extensions

Each cap flag gates a small extension interface and/or extra normalized-event variants. UI does `if (backend.capabilities().X) { … }`.

```ts
interface ReasoningCapable {
  // Events:
  //   { type: 'assistant.reasoning.delta'; text: string }
  //   { type: 'assistant.reasoning.done'; text: string }
  setReasoningConfig?(sessionId: SessionId, cfg: ReasoningConfig): void;
}

interface ReasoningSignatureCapable extends ReasoningCapable {
  // Event:
  //   { type: 'assistant.reasoning.signature'; blockId; signature: string }
  verifyReasoningBlock(blockId: string, sig: string): boolean;   // Claude integrity check
}

interface McpCapable {
  listMcpServers(): Promise<McpServerInfo[]>;
  addMcpServer(spec: McpServerSpec): Promise<void>;
  removeMcpServer(name: string): Promise<void>;
  // Tool-call events carry an optional `mcpServer: string`
}

interface SubAgentCapable {
  // Events:
  //   { type: 'subagent.started'; toolCallId; agentName }
  //   { type: 'subagent.completed'; toolCallId; agentName }
  //   { type: 'subagent.failed'; toolCallId; agentName; error }
  listSubAgents?(): Promise<SubAgentInfo[]>;
}

interface PlanModeCapable {
  setPlanMode(sessionId: SessionId, on: boolean): void;
  // Event:
  //   { type: 'planMode.exitRequested'; reqId; summary; planContent; actions }
  resolvePlanModeExit(reqId: string, decision: 'approve' | 'keepPlanning'): Promise<void>;
}

interface HooksCapable {
  getHookConfig(): Promise<HookConfig>;
  setHookConfig(cfg: HookConfig): Promise<void>;
}

interface CompactionCapable {
  // Events:
  //   { type: 'session.compaction.started' }
  //   { type: 'session.compaction.completed'; preTokens; postTokens; summary? }
  triggerCompaction?(sessionId: SessionId): Promise<void>;
}
```

## Per-backend capability matrix

| Capability               | Claude Code | Codex CLI | Gemini CLI | Copilot CLI | Llama HTTP |
| ------------------------ | :---------: | :-------: | :--------: | :---------: | :--------: |
| `agentic`                |     ✅      |    ✅     |     ✅     |     ✅      |     ❌     |
| `attachments.image`      |     ✅      |    ✅     |     ✅     |     ✅      | ✅ (multimodal models) |
| `attachments.file`       |     ✅      |    ✅     |     ✅     |     ✅      |     ❌     |
| `resume` (kind)          |   native    |  native?  |   native (checkpointing) | native (`/chronicle`) | replay |
| `reasoning`              |     ✅      | ✅ (reasoning models) | ✅ (thinking models) | ✅ | ✅ (Ollama `thinking` field) |
| `reasoningSignature`     |     ✅      |    ❌     |     ❌     |     ❌      |     ❌     |
| `mcp`                    |     ✅      |     ?     |     ✅     |     ✅      |     ❌     |
| `slashCommands`          |     ✅      |     ?     |     ✅     |     ✅      |     ❌     |
| `hooks`                  |     ✅      |    ❌     |     ❌     |     ✅      |     ❌     |
| `subAgents`              | ✅ (Task / TaskOutput / TaskStop tools) | ❌ | ❌ | ✅ (custom agents + skills) | ❌ |
| `planMode`               |     ✅      |    ❌     |     ❌     | partial (`/delegate`) | ❌ |
| `compaction`             | ✅ (internal) |   ?    |     ?      | ✅ (events)  |     ❌     |
| `citations`              | ✅ (web search) | ✅ (browsing) | partial | partial    |     ❌     |
| `cacheUsage`             |     ✅      |    ❌     |     ❌     |      ?      |     ❌     |
| `costTracking`           |     ✅      |  partial  |     ❌     |     ✅      | ❌ (local) |

`?` = not confirmed in the docs surveyed; flag deferred to implementation-time check.

## Group D — Native escape hatch

`Backend.getNativeAdapter()` returns a backend-specific object the UI does not import directly. Power-user settings and provider-specific concepts live here so the facade doesn't grow forever.

| Backend     | Native adapter exposes (examples)                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `setThinkingBudget`, `getOAuthAccount`, `hookServerHandle`, MCP stdio config, signature-verification key                      |
| Codex       | `setWorkspaceMode`, `setApprovalMode`, ChatGPT plan tier introspection                                                        |
| Gemini CLI  | `setSafetyFilters`, `setVertexProject`, `setSandboxMode`, trusted-folders config                                              |
| Copilot CLI | `setEnterpriseOrg`, `setCustomAgentDir`, Copilot subscription tier                                                            |
| Llama HTTP  | `setTemperature`, `setTopP`, `setTopK`, `setRepeatPenalty`, `setNumGpuLayers`, `setKeepAlive`, GGUF / model-file path; opt-in `enableToolLoop({tools, executor})` for power users who want to drive Llama agentically — this stays in Group D rather than flipping `capabilities.agentic`, so the UI treats Llama as chat-only by default |

## Where the existing plugin code maps in

Adopting this facade in [obsidian-claude-code-sidebar](../../..) would mean:

- [src/cli/runner.ts](../../../src/cli/runner.ts) → becomes the `claude-code` backend's implementation of `sendTurn` + `abortTurn`.
- [src/cli/events.ts](../../../src/cli/events.ts) → its event normalizer becomes the `claude-code` backend's translator from Claude Code stream-JSON into `NormalizedEvent`.
- [src/cli/auth.ts](../../../src/cli/auth.ts) → `authStatus` / `signIn` / `signOut` for the `claude-code` backend.
- [src/permissions/hookServer.ts](../../../src/permissions/hookServer.ts) → backs the `tool.permission.requested` events + `resolvePermission` for the `claude-code` backend; goes behind `getNativeAdapter().hookServerHandle` because no other backend uses it.
- [src/session/turnCoordinator.ts](../../../src/session/turnCoordinator.ts) → moves *up* to be backend-agnostic, consuming `NormalizedEvent` instead of Claude Code stream-JSON.
- [src/ui/view.ts](../../../src/ui/view.ts) → reads `backend.capabilities()` once on mount, conditionally renders Group B/C chrome.

A separate implementation plan should sequence the extraction, starting with carving the existing Claude Code path into a backend module behind the facade — without changing UI behavior — and only then adding a second backend.

---

# Appendix A — Streaming protocol comparison (research basis)

How the streaming events from each provider map onto each other. This was the input that shaped the facade above; preserved here so the design's normalization choices stay traceable.

## A.1 Per-provider event inventory

### Claude (Anthropic Messages API, SSE)

Block-structured. Each output piece (text, tool call, thinking) is an **indexed content block** with start → delta(s) → stop. The whole turn is wrapped by `message_start` … `message_stop`.

| Event | Purpose |
| --- | --- |
| `message_start` | Top-level: empty `Message` object, model, role, initial usage. |
| `content_block_start` | New block opened at `index` (block type: `text`, `tool_use`, `server_tool_use`, `thinking`, `web_search_tool_result`, …). |
| `content_block_delta` | Incremental update to block at `index`; carries one of these `delta` variants: `text_delta`, `input_json_delta` (partial JSON for `tool_use.input`), `thinking_delta`, `signature_delta` (integrity sig for thinking block), `citations_delta`. |
| `content_block_stop` | Block at `index` finalized. |
| `message_delta` | Top-level changes: `stop_reason`, `stop_sequence`, **cumulative** `usage`. |
| `message_stop` | Turn over. |
| `ping` | Keepalive, may appear anywhere. |
| `error` | In-stream error (e.g. `overloaded_error`). |

### ChatGPT / Codex — OpenAI Responses API (newer)

Item/part-structured, with the **most granular event taxonomy** of any provider here. Hierarchy: `response` → `output_item[]` → `content_part[]` → text/refusal/etc.

- Lifecycle: `response.queued`, `response.created`, `response.in_progress`, `response.completed`, `response.incomplete`, `response.failed`, `error`.
- Item assembly: `response.output_item.added` / `.done`.
- Content part: `response.content_part.added` / `.done`.
- Text: `response.output_text.delta` / `.done`, `response.output_text.annotation.added`.
- Refusal: `response.refusal.delta` / `.done`.
- Function (custom) calls: `response.function_call_arguments.delta` / `.done`.
- Reasoning: `response.reasoning_text.delta` / `.done`; summary path `response.reasoning_summary_part.added/done` + `response.reasoning_summary_text.delta/done`.
- Built-in tools (separate per-tool lifecycle):
  - `response.web_search_call.in_progress` / `.searching` / `.completed`
  - `response.file_search_call.in_progress` / `.searching` / `.completed`
  - `response.code_interpreter_call.in_progress` / `.interpreting` / `.completed`, plus `code_interpreter_call_code.delta` / `.done`
  - `response.mcp_call.in_progress` / `.completed` / `.failed`, plus `mcp_call_arguments.delta` / `.done`

### ChatGPT — OpenAI Chat Completions (legacy, still what most "Codex‑style" client code consumes)

Single shape repeated. Each SSE event is a `chat.completion.chunk` with `choices[i].delta` containing partial `role` / `content` / `tool_calls` / (optionally) `reasoning_content`. `finish_reason` arrives on the last chunk. Stream terminates with literal `data: [DONE]`. **No named events** — type is implicit in the chunk shape.

### Gemini — `streamGenerateContent`

Stream of incremental `GenerateContentResponse` JSON objects (same shape as the non-streamed response). Each chunk:

- `candidates[].content.parts[]` — appended pieces: text, `functionCall`, `inlineData`, etc.
- `finishReason` — only on terminal chunk (`STOP`, `MAX_TOKENS`, `SAFETY`, …).
- `usageMetadata` — token counts (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` for thinking models, `totalTokenCount`).
- `promptFeedback`, `modelVersion`, `responseId`.

**No discrete event names.** Function calls arrive as whole `functionCall` objects in `parts[]` (not streamed JSON). Thinking is exposed only as a token count, not as content.

### GitHub Copilot — Copilot SDK

Operates one level above a model API: it's an **agent session protocol**, not just a token stream. Every action (thinking, writing, tool calls, permission prompts, sub-agents) is a typed event. Source: [docs.github.com Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events).

- Turn / session lifecycle: `assistant.turn_start`, `assistant.turn_end`, `session.idle`, `session.shutdown`.
- Assistant content: `assistant.intent`, `assistant.message`, `assistant.message_delta`, `assistant.reasoning`, `assistant.reasoning_delta`, `assistant.usage`, `assistant.streaming_delta` (raw byte progress).
- Tools: `tool.user_requested`, `tool.execution_start`, `tool.execution_partial_result`, `tool.execution_progress`, `tool.execution_complete`.
- Permissions / user input: `permission.requested` / `.completed`, `user_input.requested` / `.completed`, `elicitation.requested` / `.completed`.
- Sub-agents / skills: `subagent.started` / `.completed` / `.failed` / `.selected` / `.deselected`, `skill.invoked`.
- Session ops: `session.error`, `session.compaction_start` / `.complete`, `session.title_changed`, `session.context_changed`, `session.usage_info`, `session.task_complete`.
- Control: `external_tool.requested` / `.completed`, `abort`, `command.queued` / `.completed`, `exit_plan_mode.requested` / `.completed`.
- Context echo: `user.message`, `system.message`.

### Llama (Meta Llama API and most third-party hosts)

OpenAI Chat-Completions-**compatible** SSE: `chat.completion.chunk` objects with `choices[].delta`, `finish_reason` on the last chunk, `data: [DONE]` terminator. No custom event names. Tool calls stream as partial `tool_calls[].function.arguments` inside `delta`. Reasoning is not standardized — some hosts pass `reasoning_content` through `delta`.

## A.2 Concept equivalence table

Reading row-by-row: a single concept, then how each provider expresses it.

| Concept | Claude | OpenAI Responses | OpenAI Chat Completions / Llama | Gemini | Copilot SDK |
| --- | --- | --- | --- | --- | --- |
| Turn opens | `message_start` | `response.created` (+ `queued`, `in_progress`) | implicit (first chunk) | implicit (first chunk) | `assistant.turn_start` |
| Turn closes (success) | `message_stop` | `response.completed` | `finish_reason` on last chunk + `data: [DONE]` | `finishReason` on last chunk | `assistant.turn_end` + `session.idle` |
| Turn closes (failure) | `error` event | `response.failed` / `response.incomplete` / `error` | HTTP error or `finish_reason: "content_filter"` | HTTP error / `promptFeedback.blockReason` | `session.error` / `abort` |
| New output piece begins | `content_block_start` | `response.output_item.added` + `response.content_part.added` | (no event — just a new `delta`) | (new entry pushed into `parts[]`) | `assistant.message` (or per-event for tool/reasoning) |
| Output piece ends | `content_block_stop` | `response.content_part.done` + `response.output_item.done` | (no event) | (no event) | (implicit; per-event lifecycle) |
| Streaming text token | `content_block_delta` + `text_delta` | `response.output_text.delta` | `choices[].delta.content` | `parts[].text` accrual | `assistant.message_delta` |
| Final full text for a piece | (accumulate `text_delta`) | `response.output_text.done` | (accumulate) | (accumulate) | `assistant.message` |
| Tool/function call requested | `content_block_start` with `tool_use` block | `response.output_item.added` (item type `function_call`) | `choices[].delta.tool_calls[]` | `parts[].functionCall` | `tool.execution_start` (or `tool.user_requested`) |
| Tool/function args streaming | `content_block_delta` + `input_json_delta` (partial JSON) | `response.function_call_arguments.delta` | `tool_calls[].function.arguments` deltas | not streamed — whole `functionCall` object | (args usually inside `assistant.message`) |
| Tool/function args final | `content_block_stop` (then parse) | `response.function_call_arguments.done` | last delta + `finish_reason: "tool_calls"` | terminal chunk | `tool.execution_start` payload |
| Tool result (server-executed) | `web_search_tool_result` block (or `tool_result` for client) | `response.web_search_call.completed` / `file_search_call.completed` / `code_interpreter_call.completed` / `mcp_call.completed` | n/a (client-only tools) | included in next `parts[]` | `tool.execution_complete` (`tool.execution_partial_result` mid-stream) |
| Reasoning / thinking text | `content_block_delta` + `thinking_delta` (with terminating `signature_delta` for integrity) | `response.reasoning_text.delta/done`, `response.reasoning_summary_text.delta/done` | not standardized (some hosts: `delta.reasoning_content`) | exposed only as `usageMetadata.thoughtsTokenCount` | `assistant.reasoning_delta` → `assistant.reasoning` |
| Citations / annotations | `content_block_delta` + `citations_delta` | `response.output_text.annotation.added` | not standardized | `groundingMetadata` on chunk | (no dedicated event) |
| Token / usage update | `usage` on `message_start` (initial) and **cumulative** on `message_delta` | `usage` on `response.completed` | `usage` typically on final chunk only | `usageMetadata` on each chunk | `assistant.usage` |
| Keepalive | `ping` | (none documented) | (none) | (none) | `assistant.streaming_delta` (byte progress) |
| Stop reason | `message_delta.delta.stop_reason` | on `response.completed` (`status` / `incomplete_details`) | `choices[].finish_reason` | `candidates[].finishReason` | derived from `assistant.turn_end` payload |

## A.3 What's actually similar, what's actually different

**The two model-level shapes that converge with Claude.** OpenAI Responses and Claude are the same family of design: typed, hierarchical, item/block-with-deltas events. Their concepts map almost 1:1 (block ↔ output_item+content_part, `text_delta` ↔ `output_text.delta`, `input_json_delta` ↔ `function_call_arguments.delta`, `thinking_delta` ↔ `reasoning_text.delta`, `citations_delta` ↔ `output_text.annotation.added`). OpenAI Responses goes one level further: separate sub-events for each built-in tool's lifecycle (`web_search_call.searching`, `code_interpreter_call.interpreting`, `mcp_call.failed`).

**The "chunk with delta" family.** OpenAI Chat Completions and Llama (and most Llama-on-X providers) share one shape: `chat.completion.chunk` with `choices[].delta`, `finish_reason` to terminate, `data: [DONE]` sentinel. There are **no named event types** — semantics are encoded in which fields appear on `delta`. If you've written code against OpenAI Chat Completions streaming, Llama works unchanged.

**Gemini is its own thing.** Same idea as Chat Completions (one repeated shape, no named events) but the shape is the **full** `GenerateContentResponse` object, not a thin delta. Function calls arrive as **whole** objects in `parts[]` rather than streamed JSON, so partial-JSON parsing — central to Claude and OpenAI tool flows — doesn't apply.

**Copilot SDK is a different layer.** Claude/OpenAI/Gemini/Llama protocols describe one model turn at the wire level. Copilot SDK describes an **agent session** wrapping many model turns plus tool execution, permissions, sub-agents, context compaction, plan mode, and slash commands. Most of those concepts exist on the Claude side via the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/user-input) too — they're just surfaced through different mechanisms (tool_use blocks the host app intercepts, plus a synchronous `canUseTool` callback for permissions) rather than dedicated wire events. Concrete mappings:

- `permission.requested` ↔ Claude's `canUseTool` callback. A synchronous callback that pauses execution and returns `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`. Not a stream event — execution stays paused until the callback returns.
- Clarifying-question / elicitation prompts ↔ Claude's `AskUserQuestion` tool. A `tool_use` block the host intercepts via `canUseTool` when `toolName === "AskUserQuestion"`; the input has `questions[]` with `header`, `options[]`, `multiSelect`, optional HTML/markdown previews.
- `exit_plan_mode.requested` ↔ Claude's `ExitPlanMode` tool (`{plan, launchSwarm}`); entering plan mode is the `EnterPlanMode` tool. Both are emitted as ordinary `tool_use` blocks the host can approve or deny.
- `subagent.started/completed/failed` ↔ Claude's `Task` tool, with `TaskOutput` / `TaskStop` for streaming and cancellation.
- `session.compaction_*` and `session.title_changed`: these stay Copilot-distinct. Claude Code handles compaction internally without a wire signal, and 0.12 removed its auto-titler — no equivalent surface today.

The shape difference matters more than the capability gap: Copilot exposes these as named wire events, Claude folds them into the unified `tool_use` protocol plus one synchronous callback for permission gating. The facade in this document translates between the two shapes (see Group B implementation note).

**Five concrete asymmetries worth noting.**

1. **Reasoning visibility.** Claude streams reasoning text (`thinking_delta`) with a cryptographic `signature_delta` for integrity verification. OpenAI Responses streams reasoning text and a separate "summary" stream. Copilot streams it. Gemini exposes it only as a token *count*. Plain Chat Completions / Llama don't standardize it.
2. **Tool-arg streaming granularity.** Claude and OpenAI (both surfaces) stream tool arguments as partial JSON. Gemini does not — you get the whole `functionCall` once.
3. **Lifecycle bookends.** Claude has explicit `message_start` / `message_stop`. OpenAI Responses has the most lifecycle states (`queued/created/in_progress/completed/incomplete/failed`). Chat Completions and Gemini are implicit. Copilot is the most explicit (`turn_start`, `turn_end`, `session.idle`).
4. **Keepalive.** Only Claude documents a `ping` event. The others rely on TCP/HTTP-level keepalive.
5. **Cumulative vs final usage.** Claude's `message_delta.usage` is cumulative across deltas; OpenAI Responses reports usage once on `response.completed`; Chat Completions/Llama report on the last chunk; Gemini reports `usageMetadata` on every chunk.

## Sources

- [Streaming Messages — Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Handle approvals and user input — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Streaming events — OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [Responses API streaming — simple guide to events (OpenAI community)](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122)
- [Gemini `generateContent` reference](https://ai.google.dev/api/generate-content)
- [Gemini CLI — README](https://github.com/google-gemini/gemini-cli/blob/main/README.md)
- [Streaming events in the Copilot SDK — GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events)
- [GitHub Copilot CLI — docs index](https://docs.github.com/en/copilot/how-tos/copilot-cli)
- [Codex CLI — README](https://github.com/openai/codex/blob/main/README.md)
- [Ollama API — chat endpoint](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Chat completion — Llama API](https://llama.developer.meta.com/docs/api/chat/)
- [llamastack/llama-stack issue #4744 — `data: [DONE]` SSE terminator](https://github.com/llamastack/llama-stack/issues/4744)
