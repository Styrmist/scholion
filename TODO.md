# TODO — next version

Carryover items from the v0.1.0 implementation review and post-MVP smoke testing. Roughly ordered by impact within each bucket.

## Known issues

- [ ] **Auth state can drift between `.claude.json` and macOS Keychain.** Symptom: Settings → Account shows "Signed in as ...", but sending a message returns "Not logged in · Please run /login" in the chat. The plugin's [`isAuthenticated()`](src/cli/auth.ts) (and `getSignedInEmail`) checks only `<configDir>/.claude.json` for the `oauthAccount` block, while the actual OAuth tokens live in the macOS Keychain entry `Claude Code-credentials-<hash>` (the comment in [src/cli/auth.ts:14-17](src/cli/auth.ts) calls this out explicitly). If the Keychain entry is missing, unreadable, or hashed for a different config dir than the JSON, the two backends disagree and the file-only check returns a false positive. The CLI subprocess streams the auth error back as a chat reply rather than a structured signal, so the failure looks like a chat response. Workaround: Sign out → Sign in again to repopulate both backends in lockstep. Proposed fix has two parts:
    1. Make `isAuthenticated()` actually probe the CLI (e.g. spawn a short `claude` invocation with `--print` on an empty/cheap prompt — or `claude doctor` / `claude auth status` if those land — and inspect exit code / first stream event) instead of just reading the JSON file. Cache the result for a few seconds to avoid spawning on every Settings open.
    2. In [src/cli/runner.ts](src/cli/runner.ts) (or the stream `normalize` step in [src/cli/events.ts](src/cli/events.ts)), detect "Not logged in" / "Please run /login" patterns in the assistant stream and surface them as a structured auth-failure event. The [TurnCoordinator](src/session/turnCoordinator.ts) should then convert that into a transcript-level notice with a "Sign in again" button (mirroring the cycle-cap interactive notice plumbing added in 0.5.0) and abort the turn instead of letting the failure render as a chat message.

## Functional

- [x] **Permission denial via structured field.** Reads `result.permission_denials[]` (entries shaped `{ tool_name, tool_use_id, tool_input }`); legacy substring matcher kept as fallback for older CLIs.
- [x] **Tool-call end-to-end smoke test.** Read/Grep/Edit lifecycle exercised; transcript replays from persisted JSON.
- [x] **Inline permission prompt verification.** All four decisions (Allow once / Allow this session / Allow always / Deny) walked through and persistence verified across reloads.
- [x] **Multi-block assistant turns.** Verified `text → tool_use → text` renders in document order in one assistant bubble.
- [x] **Surface stderr to the user.** Per-session collapsible diagnostics panel ([src/ui/diagnosticsPanel.ts](src/ui/diagnosticsPanel.ts)) captures stderr and `api_retry` events into `SessionRecord.diagnostics` (capped at 500, persisted, clearable).
- [x] **`--resume` failure fallback** now detected via `result.errors[]` in addition to stderr; `LOST_SESSION_PATTERN` broadened to match the CLI's actual `"No conversation found with session ID"` message.

## Polish

- [x] **Running session cost + token usage.** `SessionRecord.usage` accumulates per-turn cost + input/output/cache tokens; `StatusPill` shows `$X.XXXX · Nk in / Nk out` in idle state, persisted across reloads.
- [x] **Spawn-delay feedback.** Status pill shows "Starting Claude…" before spawn, replaced with "Thinking…" on the first `system_init` event.
- [x] **Tool result rendering for big outputs.** Card body shows preview as before; outputs over 4 KB get a "View full output (N B/KB/MB)" button that opens a scrollable monospace modal with copy-to-clipboard.
- [x] **Streaming markdown render cost.** Chunk-and-commit: paragraphs separated by `\n\n` outside fenced code blocks are rendered once into committed sub-blocks; only the trailing live tail re-renders on each tick.
- [x] **Session picker UX.** Click chip opens an Obsidian SuggestModal with fuzzy search and relative-time hints (`2h ago`, `Mar 14`); separate "⋯" menu for rename/delete/new chat.
- [x] **Composer keybindings.** Placeholder hints `(Enter or ⌘↵ to send, Shift+Enter for newline)`. Cmd+Enter already worked via existing handler.
- [x] **Stop button.** Now a prominent red-background pill (`background: var(--color-red)`) instead of muted secondary; replaces the Send slot when busy.

## Risk hardening

- [x] **`configDir` glob escaping.** Meta chars (`*?[]\`) in the configDir path are now wrapped in character classes via `escapeGlobMetaChars` before substitution into the deny patterns.
- [x] **Argv-level OAuth env strip.** Extended strip list to cover `CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_SKIP_*`, `CLAUDE_CODE_CLIENT_*`, `CLAUDE_CODE_CERT_*`, `AWS_*`, `AZURE_*`, `GOOGLE_*`, `GCLOUD_*` plus exact strips for `CLAUDE_CODE_API_KEY`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. Header comment points at the upstream env-vars doc as the audit reference.
- [x] **GPG manifest verification.** Install flow now fetches `manifest.json.sig` and verifies it against Anthropic's embedded RSA-4096 public key (fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`) via `openpgp.js` before trusting the manifest. Fail-closed: signature missing/malformed/invalid → install rejected, no binary written.

## Architectural

- [ ] *Deferred.* **Extract `TurnCoordinator` from [src/ui/view.ts](src/ui/view.ts).** ChatView is now ~570 lines. Splitting `runTurn`/`handleInlineDenial`/`handlePermissionDecision`/`abortCurrent` into a dedicated coordinator class would consolidate the `currentRecord !== turnRecord` race guards and the `pendingPermission` state machine. Pure refactor, no user-visible change — revisit if/when the file makes a real change painful.
- [ ] *Deferred.* **Index `toolCards` and `toolBlocks` by id.** `toolCards` is already a `Map` in `TranscriptView`. `toolBlocks` is walked linearly via `findToolBlock`/`findToolBlockGlobal`, but the hot path (`applyToolResult` in transcript) only walks the current turn (typically 1–10 blocks); the cold paths (permission decisions, abort) run on rare interactive events. Re-evaluate when sessions in the wild start exceeding ~10k tool calls.
- [x] **Persist `lastTurnSummary` for the picker.** Populated from the first sentence (≤140 chars, sentence-boundary aware) of the last assistant turn after each `runTurn` completes; rendered as a 2-line clamp under the title in the SuggestModal.

## Hook IPC follow-ups

Deferred from the system-temp IPC migration ([src/permissions/hookServer.ts](src/permissions/hookServer.ts)).

- [ ] *Deferred.* **Per-Obsidian-instance isolation for the multi-instance-same-vault case.** Two instances open on the same vault hash to the same IPC dir; either instance's `HookServer` can pick up the other's `.req`. Symptom is over-permissive (the receiving instance's allow-list is used). Fix: embed an instance UUID in `.req` filenames + filter — touches both hook scripts and the protocol.
- [ ] *Deferred.* **Remove the backup directory poller entirely.** The 1s `scanForMissedRequests` was added to recover from `fs.watch` drops on iCloud-FSEvents under heavy concurrent writes. With local system-temp the poller almost never fires; revisit removal after a release cycle of telemetry.
- [ ] *Deferred.* **User-facing `Notice` for ENOSPC / EACCES on the IPC dir.** Today these surface as a generic "Plugin could not read" deny; better UX would be a one-shot `Notice` pointing at the path in Settings → Advanced.
- [ ] *Deferred.* **Rename `paths.tmpDir` → `paths.hookIpcDir`** at every call site (~9 sites, 5 files) plus the env var `OBSIDIAN_CC_TMP_DIR` → `OBSIDIAN_CC_HOOK_IPC_DIR`. Also requires regenerating the on-disk `permissionHook.sh`/`permissionHook.ps1` so old scripts on disk don't silently break. Mechanical churn; deferred for cost vs. clarity.
- [ ] *Deferred.* **Migrate other plugin state to system temp.** Out of scope: only IPC was mislocated. `bin/`, `config/`, `sessions/` belong in the vault.

## Cross-platform

- [ ] **Windows argv length cap (~32 KB).** Long pasted notes overflow. Fallback path: when prompt > 20 KB, write to `<plugin>/tmp/turn-<n>.txt` and feed via stdin (`-p` reads stdin if no positional arg) or use `--prompt-file` if it lands in the CLI.
- [ ] **Stale `claude.prev` cleanup on Windows.** A failed install can leave a file that's locked while Obsidian is running. Add a startup pass that retries unlinking files older than 24 h.
- [ ] Cross-platform smoke test (macOS x64, Linux glibc x64, Linux musl, Windows x64) — only macOS arm64 has been exercised.
- [x] iCloud-synced vault path with spaces and unicode — current dev vault has both; full end-to-end usage across v0.2.0–v0.3.x has worked without sync issues.

## Verification not yet run

- [x] Plugin reload during an in-flight turn — verified via Activity Monitor: `claude` child process disappears within ~2s of plugin disable / Obsidian reload, no zombies.

## Extra
- [x] Model selection in settings: dropdown with `sonnet` (default), `opus`, `haiku`, `opusplan`, plus a Custom… escape hatch for full model names / inference profile arns / deployment names.
- [ ] Select text in chat with claude
- [x] **Group requests so allow applies to a batch.** Same-tool sibling hooks arriving while a permission prompt is open now batch into the active prompt; the user's single decision (Allow once / session / always / Deny) covers all of them. Prompt lists every input and switches button labels to "Allow all once" / "Deny all" so the scope is explicit. Drains queued same-tool entries into a fresh prompt when one opens. Companions in the same release: per-session cost guard (warn + hard cap with one-time bypass) and per-turn `tool_use` cap that pauses the next hook-gated tool with a Continue / Stop transcript prompt.
- [ ] Prepare some CLAUDE.md/AGENTS.md to optimise assistant usage
- [ ] select between current claude code approach (donwloaded separate copy) vs preinstalled by user
