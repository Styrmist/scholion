# Adding a new backend provider

Every backend implements the `Backend` interface from
[`src/backend/types.ts`](../backend/types.ts) and is registered in
[`src/main.ts`](../main.ts) during plugin onload. UI and session code never
imports a concrete provider — the registry is the only seam.

## Recipe

### 1. Scaffold the directory

Create `src/providers/<your-id>/` with at minimum:

- `backend.ts` — the class implementing `Backend` (and any capability mixins it supports)
- `types.ts` — provider-internal types and a `<Provider>FullSurface` alias if it implements multiple capabilities (see [`src/providers/claude-code/types.ts`](claude-code/types.ts) for the pattern)
- `nativeAdapter.ts` — the object returned by `getNativeAdapter()` (provider-specific knobs)
- `eventTranslator.ts` — translates the wire/SDK events into `NormalizedEvent`
- `errorMap.ts` — produces `NormalizedError` from the provider's failure modes
- `stopReasonMap.ts` — maps provider stop reasons into the `StopReason` union
- Tests co-located as `*.test.ts`

### 2. Add the BackendId

Edit [`src/backend/ids.ts`](../backend/ids.ts) and add your id to the
`BackendId` union:

```ts
export type BackendId =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'copilot-cli'
  | 'llama-http'
  | 'your-id';
```

This is the **only** facade file you should need to edit. If you find
yourself editing [`src/backend/types.ts`](../backend/types.ts), something is
wrong — your provider is reaching for capabilities the interface doesn't
model. Either the capability belongs on `getNativeAdapter()` (provider-
specific) or the spec needs revision (open a discussion).

### 3. Implement the Backend interface

Required Group A methods (every backend):

- `id()`, `capabilities()`, `availableModels()`
- `isAvailable()`, `version()`, `install?()`, `update?()`
- `authStatus()` plus exactly one auth path: `signIn?()/signOut?()` (subscription/OAuth) OR `setApiKey?()/clearApiKey?()` (key-based)
- `createSession()`, `listSessions()`, `getSession()`, `renameSession()`, `deleteSession()`
- `sendTurn(req)` returning `AsyncIterable<NormalizedEvent>`, `abortTurn(turnId)`
- `setModel()`, `setSystemPrompt?()`
- `diagnostics(sessionId)` returning `AsyncIterable<DiagnosticEvent>`
- `hasNativeContext(sessionId)` (returns false for HTTP/replay backends)
- `getNativeAdapter()`

If your backend is agentic (CLI-backed or tool-using), also implement
`AgentBackend`:

- `setCwd()`, `getCwd()`
- `setPermissionPolicy()`, `removePermissionPolicy()`, `resolvePermission()`
- `availableTools()`
- `discoverSlashCommands()`

For each per-feature capability your backend supports, implement the
corresponding mixin from
[`src/backend/capabilities.ts`](../backend/capabilities.ts) — `McpCapable`,
`HooksCapable`, `PlanModeCapable`, `ReasoningCapable`,
`ReasoningSignatureCapable`, `SubAgentCapable`, `CompactionCapable`. The
capability flags returned from `capabilities()` must match the methods you
implement: the type guards `is*Capable()` rely on this invariant.

### 4. Translate events into NormalizedEvent

Your `eventTranslator.ts` is where most of the design work happens. Read
Appendix A of the design spec
[`docs/superpowers/specs/2026-05-06-multi-provider-backend-facade-design.md`](../../docs/superpowers/specs/2026-05-06-multi-provider-backend-facade-design.md)
for the equivalence table — your provider's wire events map to
`NormalizedEvent` variants there.

Required `NormalizedEvent` discriminants every backend must produce:

- `turn.usage` (cumulative-snapshot — emit at least once on completion)
- `turn.completed` or `turn.failed`
- `assistant.text.delta` and/or `assistant.text.done`

If `capabilities().agentic`, additionally produce as relevant:

- `tool.call.requested`, `tool.call.started`, `tool.call.partialResult`,
  `tool.call.completed`
- `tool.permission.requested` (if your backend gates tool use; the UI
  listens for this and prompts the user)

### 5. Register in main.ts

In `Plugin.onload()`:

```ts
const yourBackend = new YourBackend(this, this.sessions, /* deps */);
this.registry.register(yourBackend);
// First-registered backend becomes default if settings.defaultBackendId is unset.
```

### 6. Tests

Per-provider test conventions (see
[`src/providers/claude-code/backend.test.ts`](claude-code/backend.test.ts)
for reference):

- A fake `<Provider>Runner` that emits a deterministic event sequence
- Coverage of: success turn, tool-use turn, permission-required turn (if
  agentic), error turn, aborted turn
- `availableModels()` and `availableTools()` return non-empty arrays
- Capability flags match implemented methods (every `true` flag has a
  working method; every `false` flag throws or is absent)

For shared behavior tests across providers (turn state machine, queueing,
batching), see [`src/session/turnCoordinator.ts`](../session/turnCoordinator.ts):
those tests should run identically against any backend.

### 7. Document provider-specific knobs

If your backend exposes anything via `getNativeAdapter()`, document it in
`src/providers/<your-id>/README.md`. The shape is open — power users
access it via
`(plugin.backend.getNativeAdapter() as <YourAdapter>).whatever()`.
Provider-specific UI (settings rows that only make sense for your backend)
should be gated by `if (plugin.backend.id() === '<your-id>')` in
[`src/ui/settingsTab.ts`](../ui/settingsTab.ts) with a `// <your-id>-specific`
comment.

### What you do NOT touch

- [`src/ui/**`](../ui/) — capability-gated rendering reads
  `backend.capabilities()` and the type guards from
  [`src/backend/capabilities.ts`](../backend/capabilities.ts). If you need
  new UI, propose a new capability mixin via a spec amendment first.
- [`src/session/turnCoordinator.ts`](../session/turnCoordinator.ts) — already
  provider-agnostic. If something doesn't fit your provider here, you have
  either a missing capability flag or a missing `NormalizedEvent` variant;
  fix at the facade level, not the coordinator.
- [`src/composer/mentions.ts`](../composer/mentions.ts) — vault-scoped, not
  provider-scoped.

If a refactor in this plan ever requires editing UI or session files for a
new provider, that's a regression — open an issue.
