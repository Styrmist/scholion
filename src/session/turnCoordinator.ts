import { Notice } from "obsidian";
import { BinaryNotInstalledError } from "../binary/installer";
import { resolvePaths } from "../binary/paths";
import { buildSettingsJson } from "../cli/settingsJson";
import { MAX_DIAGNOSTICS_PER_SESSION } from "../constants";
import type { CapturedContext } from "../context/activeNote";
import type ClaudeCodePlugin from "../main";
import {
	DiagnosticEntry,
	PermissionDecision,
	PermissionMode,
	SendOptions,
	StreamEvent,
	UsageInfo,
} from "../types";
import * as logger from "../utils/log";
import { buildHookCommand } from "../permissions/hookCommandString";
import { projectedContextSize } from "./contextWarn";
import { applyDecision } from "./permissions";
import type { SessionRecord } from "./store";
import { summarizeLastAssistantTurn } from "./summarize";
import { ToolIndex } from "./toolIndex";
import {
	partitionQueueByTool,
	QueuedPermission,
	shouldBatchSameTool,
	shouldPauseForCycleCap,
} from "./turnGuards";
import { canTransition, TurnLease, TurnState } from "./turnState";

const LOST_SESSION_PATTERN = /session.*not\s*found|unknown\s*session|no\s*conversation\s*found/i;

export type TurnOutcome =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "error"; error: Error }
	| { kind: "denied_inline" }
	| { kind: "stale" };

export interface CycleCapPrompt {
	count: number;
	cap: number;
	onContinue: () => void;
	onStop: () => void;
}

export interface CoordinatorEvents {
	onStateChange(state: TurnState): void;
	onStreamEvent(event: StreamEvent): void;
	onDiagnostic(entry: DiagnosticEntry, record: SessionRecord): void;
	onUsageChanged(record: SessionRecord): void;
	onSystemNotice(message: string): void;
	/**
	 * The primary card identified by toolUseId needs a permission decision.
	 * `batchedToolUseIds` lists same-tool sibling cards whose hooks are paused
	 * and will receive the same decision; the UI should suppress per-card
	 * prompts on those cards and surface the batch count in the primary prompt.
	 */
	onPermissionRequired(toolUseId: string, batchedToolUseIds: string[]): void;
	onPermissionGranted(toolUseId: string): void;
	onAborted(): void;
	onTurnFinished(outcome: TurnOutcome): void;
	/**
	 * Tool-call cap reached during the active turn. The CLI hook for the next
	 * tool is paused. UI should surface a Continue / Stop choice; selecting
	 * one calls back through the supplied callbacks.
	 */
	onCycleCapReached(prompt: CycleCapPrompt): void;
	/**
	 * Fires after every successful turn with the projected size of the next
	 * turn's prompt (input + cache_read + cache_creation + output). UI-side
	 * warning logic compares this against the configured threshold and is
	 * responsible for one-shot deduping.
	 */
	onContextWarn(record: SessionRecord, projectedNextTurnTokens: number): void;
}

/**
 * Owns the in-flight turn lifecycle, abort signaling, and permission flow.
 * UI subscribes via CoordinatorEvents; the coordinator never touches the DOM.
 *
 * Lease invariant: a monotonic `activeLease` counter is minted at every spawn.
 * Each `await` resumption and event-handler entry checks `isLeaseValid(lease)`
 * before mutating state. `bindRecord(null)` invalidates the lease and aborts.
 */
export class TurnCoordinator {
	private record: SessionRecord | null = null;
	private state: TurnState = { kind: "idle" };
	private activeLease: TurnLease = 0;
	private leaseSeq = 0;
	private abortController: AbortController | null = null;
	/**
	 * Pending hook escalations queued while another permission prompt is open.
	 * Claude can emit parallel tool calls and the CLI invokes hooks for each
	 * concurrently; we serialize the prompts so the user decides one at a time.
	 * Same-tool entries here are drained into the active prompt as a batch when
	 * one opens.
	 */
	private permissionQueue: QueuedPermission[] = [];

	/**
	 * Per-turn tool_use counter. Reset at each `runTurn`. Compared against
	 * `settings.maxToolCallsPerTurn` to decide whether to pause at the next
	 * hook-gated tool.
	 */
	private toolUseCountThisTurn = 0;
	/**
	 * When the cycle cap fires, we hold the next hook here instead of routing
	 * into the regular permission prompt. The UI's Continue / Stop choice
	 * resolves the held entry by allowing the regular flow to run, or by
	 * denying + aborting.
	 */
	private cycleCapHeld: { toolUseId: string; toolName: string; lease: TurnLease } | null = null;

	constructor(
		private plugin: ClaudeCodePlugin,
		private toolIndex: ToolIndex,
		private getContext: () => CapturedContext | null,
		private events: CoordinatorEvents,
	) {}

	bindRecord(record: SessionRecord | null): void {
		if (this.record === record) return;
		this.invalidateLease();
		this.drainQueueWithDeny("Session switched before decision");
		this.releaseCycleCapHeld("deny", "Session switched");
		this.record = record;
		this.toolIndex.clear();
		if (record) this.toolIndex.rebuildFrom(record);
		this.transitionTo({ kind: "idle" });
	}

	getState(): TurnState {
		return this.state;
	}

	isBusy(): boolean {
		return this.state.kind !== "idle" && this.state.kind !== "error";
	}

	isAwaitingPermission(): boolean {
		return this.state.kind === "awaiting_permission";
	}

	startTurn(
		prompt: string,
		contextHashToCommit: string | undefined,
		opts: { permissionMode?: PermissionMode } = {},
	): void {
		const record = this.record;
		if (!record) return;
		this.toolUseCountThisTurn = 0;
		this.cycleCapHeld = null;
		void this.runTurn(record, prompt, contextHashToCommit, this.mintLease(), opts.permissionMode);
	}

	/**
	 * Called by HookServer when a real PreToolUse hook fires for a tool that
	 * isn't in the fast-path allow/deny lists. The card already exists (it was
	 * created by the assistant's tool_use event); we flip its status and ask
	 * the UI to show the permission prompt. The CLI is paused inside the hook
	 * script, waiting for our `.resp` file.
	 */
	beginHookWait(toolUseId: string, toolName: string): boolean {
		logger.log("[coord] beginHookWait called", { toolUseId, toolName, state: this.state.kind, hasRecord: !!this.record });
		if (!this.record) {
			logger.log("[coord] beginHookWait: no record, rejecting");
			return false;
		}
		const lease = currentLease(this.state);
		if (lease === null) {
			logger.log("[coord] beginHookWait: no lease (idle), rejecting");
			return false;
		}

		if (this.state.kind === "awaiting_permission") {
			// Same-tool sibling arriving while a prompt is open: batch into the
			// active prompt so the user's single decision covers all of them.
			if (shouldBatchSameTool(this.state.pending.tool, toolName, this.cycleCapHeld !== null)) {
				logger.log("[coord] beginHookWait: batching same-tool sibling into active prompt", {
					toolUseId,
					tool: toolName,
				});
				this.state.pending.batchedToolUseIds.push(toolUseId);
				this.events.onPermissionRequired(
					this.state.pending.placeholderToolUseId,
					this.state.pending.batchedToolUseIds,
				);
				return true;
			}
			logger.log("[coord] beginHookWait: already awaiting, queueing", { toolUseId, queueLen: this.permissionQueue.length });
			this.permissionQueue.push({ toolUseId, toolName });
			return true;
		}

		// While the cycle-cap prompt is pending, more siblings may arrive (the
		// CLI keeps streaming and emits hooks for the next tools in the batch).
		// Defer them into the queue; openPermissionPrompt at Continue time will
		// drain same-tool siblings from the queue into the prompt batch.
		if (this.cycleCapHeld !== null) {
			logger.log("[coord] beginHookWait: cycle-cap held, queueing sibling", { toolUseId, toolName });
			this.permissionQueue.push({ toolUseId, toolName });
			return true;
		}

		if (
			this.state.kind !== "streaming" &&
			this.state.kind !== "tool_running" &&
			this.state.kind !== "starting"
		) {
			logger.log("[coord] beginHookWait: unexpected state, rejecting", { state: this.state.kind, toolUseId });
			return false;
		}

		// Cycle-cap pause point. The hook subprocess is already paused waiting
		// for our .resp file, so holding off on `respond` here is what actually
		// pauses the CLI. Fast-path tools (Read/Grep/Glob) bypass this — but
		// fast-path tools are by definition pre-approved by the user, so the
		// cap defending against runaway Edit/Write/Bash loops is the right
		// scope anyway.
		const cap = this.plugin.settings.maxToolCallsPerTurn;
		if (shouldPauseForCycleCap(this.toolUseCountThisTurn, cap, this.cycleCapHeld !== null)) {
			logger.log("[coord] beginHookWait: cycle cap hit, holding tool", {
				toolUseId,
				toolName,
				count: this.toolUseCountThisTurn,
				cap,
			});
			this.cycleCapHeld = { toolUseId, toolName, lease };
			this.events.onCycleCapReached({
				count: this.toolUseCountThisTurn,
				cap,
				onContinue: () => this.resolveCycleCapContinue(),
				onStop: () => this.resolveCycleCapStop(),
			});
			return true;
		}

		logger.log("[coord] beginHookWait: opening prompt", { toolUseId });
		this.openPermissionPrompt(toolUseId, toolName, lease);
		return true;
	}

	/**
	 * User clicked Continue on the cycle-cap prompt. Reset the per-turn counter
	 * and route the held tool through the regular permission flow as if the
	 * cap had not fired.
	 */
	private resolveCycleCapContinue(): void {
		const held = this.cycleCapHeld;
		if (!held) return;
		if (!this.isLeaseValid(held.lease)) {
			// Turn ended while the user deliberated; deny the held hook.
			this.plugin.hookServer.respond(held.toolUseId, "deny", "Turn ended");
			this.cycleCapHeld = null;
			return;
		}
		this.toolUseCountThisTurn = 0;
		this.cycleCapHeld = null;
		this.openPermissionPrompt(held.toolUseId, held.toolName, held.lease);
	}

	/** User clicked Stop. Deny the held hook and abort the turn. */
	private resolveCycleCapStop(): void {
		const held = this.cycleCapHeld;
		if (!held) return;
		this.plugin.hookServer.respond(held.toolUseId, "deny", "Tool-call cap reached; user stopped");
		const block = this.record ? this.toolIndex.resolve(this.record, held.toolUseId) : null;
		if (block) block.status = "denied";
		this.cycleCapHeld = null;
		this.abort();
	}

	/** Release any held cycle-cap entry (used during session switch / unbind). */
	private releaseCycleCapHeld(decision: "allow" | "deny", reason: string): void {
		const held = this.cycleCapHeld;
		if (!held) return;
		this.plugin.hookServer.respond(held.toolUseId, decision, reason);
		this.cycleCapHeld = null;
	}

	private openPermissionPrompt(toolUseId: string, toolName: string, lease: TurnLease): void {
		// Drain any same-tool entries already queued so the prompt represents
		// the full pending batch from the start.
		const { matching: batched, remaining } = partitionQueueByTool(this.permissionQueue, toolName);
		this.permissionQueue = remaining;
		this.transitionTo({
			kind: "awaiting_permission",
			lease,
			pending: {
				placeholderToolUseId: toolUseId,
				tool: toolName,
				// `hookId` is just a discriminator selecting the hook code path
				// in decidePermission; we reuse toolUseId since they're 1:1.
				hookId: toolUseId,
				batchedToolUseIds: batched,
			},
		});
		this.events.onPermissionRequired(toolUseId, batched);
	}

	private dequeueNextPermission(): void {
		while (this.permissionQueue.length > 0) {
			const next = this.permissionQueue.shift();
			if (!next) return;
			const lease = currentLease(this.state);
			if (lease === null) {
				// Lease invalidated mid-decision: deny remaining and stop.
				this.plugin.hookServer.respond(next.toolUseId, "deny", "Turn ended");
				continue;
			}
			// If the user's decision auto-applied (e.g. "Allow always" promoted
			// the tool to settings.allowedTools), the hook fast-path will already
			// have responded for queued tools by the time we get here. Skip any
			// queued entry whose tool has since become fast-path allowed/denied.
			const grants = this.record?.permissions;
			const settings = this.plugin.settings;
			if (
				toolMatchesList(grants?.allowedTools ?? [], next.toolName) ||
				toolMatchesList(settings.allowedTools, next.toolName)
			) {
				this.plugin.hookServer.respond(next.toolUseId, "allow");
				continue;
			}
			if (
				toolMatchesList(grants?.deniedTools ?? [], next.toolName) ||
				toolMatchesList(settings.disallowedTools, next.toolName)
			) {
				this.plugin.hookServer.respond(next.toolUseId, "deny", "Tool denied");
				continue;
			}
			if (
				this.state.kind !== "streaming" &&
				this.state.kind !== "tool_running" &&
				this.state.kind !== "starting"
			) {
				logger.warn("dequeueNextPermission: unexpected state", { state: this.state.kind });
				this.plugin.hookServer.respond(next.toolUseId, "deny", "Permission UI unavailable");
				continue;
			}
			this.openPermissionPrompt(next.toolUseId, next.toolName, lease);
			return;
		}
	}

	private drainQueueWithDeny(reason: string): void {
		while (this.permissionQueue.length > 0) {
			const next = this.permissionQueue.shift();
			if (!next) return;
			this.plugin.hookServer.respond(next.toolUseId, "deny", reason);
		}
	}

	abort(): void {
		this.drainQueueWithDeny("Turn aborted");
		this.releaseCycleCapHeld("deny", "Turn aborted");
		if (this.state.kind === "awaiting_permission") {
			const pending = this.state.pending;
			const record = this.record;
			const allIds = [pending.placeholderToolUseId, ...pending.batchedToolUseIds];
			for (const id of allIds) {
				if (record) {
					const block = this.toolIndex.resolve(record, id);
					if (block) block.status = "denied";
				}
				this.plugin.hookServer.respond(id, "deny", "Turn aborted");
			}
			this.transitionTo({ kind: "idle" });
		}
		if (this.abortController) {
			this.abortController.abort();
			this.events.onAborted();
		}
	}

	async decidePermission(toolUseId: string, decision: PermissionDecision): Promise<void> {
		logger.log("[coord] decidePermission called", { toolUseId, decision, state: this.state.kind });
		const record = this.record;
		if (!record) {
			logger.log("[coord] decidePermission: no record, ignored");
			return;
		}
		if (this.state.kind !== "awaiting_permission") {
			logger.log("[coord] decidePermission: not awaiting_permission, ignored", { state: this.state.kind });
			return;
		}
		const pending = this.state.pending;
		if (pending.placeholderToolUseId !== toolUseId) {
			logger.log("[coord] decidePermission: pending mismatch", { pending: pending.placeholderToolUseId, got: toolUseId });
			return;
		}
		const lease = this.state.lease;
		const batchedIds = pending.batchedToolUseIds;

		const block = this.toolIndex.resolve(record, toolUseId);
		if (!block) {
			logger.log("[coord] decidePermission: block missing", { toolUseId });
			return;
		}

		logger.log("[coord] decidePermission applying", {
			toolUseId,
			decision,
			tool: block.tool,
			batchedCount: batchedIds.length,
		});
		await this.applyHookDecision(record, block.tool, toolUseId, batchedIds, decision, lease);
	}

	/**
	 * Hook flow: the CLI is paused inside the hook script. Write the response
	 * file via HookServer; the same turn continues — no resend, no abort.
	 */
	private async applyHookDecision(
		record: SessionRecord,
		tool: string,
		toolUseId: string,
		batchedIds: string[],
		decision: PermissionDecision,
		lease: TurnLease,
	): Promise<void> {
		const allIds = [toolUseId, ...batchedIds];
		if (decision === "deny") {
			for (const id of allIds) {
				this.plugin.hookServer.respond(id, "deny", "User denied via Obsidian plugin");
				const denyBlock = this.toolIndex.resolve(record, id);
				if (denyBlock) denyBlock.status = "denied";
			}
			this.plugin.sessions.scheduleSave(record);
			// "deny once" affects only these specific calls; do NOT add to
			// record.permissions.deniedTools (that would be "deny always"
			// semantics — out of scope for this prompt).
			this.transitionTo({ kind: "streaming", lease, sawAssistantOutput: true });
			this.dequeueNextPermission();
			return;
		}

		record.permissions = applyDecision(record.permissions, tool, decision);
		if (decision === "global") {
			const settings = this.plugin.settings;
			if (!settings.allowedTools.includes(tool)) settings.allowedTools.push(tool);
			settings.disallowedTools = settings.disallowedTools.filter((t) => t !== tool);
			await this.plugin.saveSettings();
			if (!this.isLeaseValid(lease) || this.record !== record) {
				// User switched sessions while saveSettings() was awaited.
				for (const id of allIds) {
					this.plugin.hookServer.respond(id, "deny", "Session switched during decision");
				}
				this.drainQueueWithDeny("Session switched during decision");
				return;
			}
		}
		this.plugin.sessions.scheduleSave(record);
		for (const id of allIds) {
			this.plugin.hookServer.respond(id, "allow");
			const allowBlock = this.toolIndex.resolve(record, id);
			if (allowBlock) allowBlock.status = "running";
		}
		// CLI will continue and emit tool_result for each id; cards flip back to running.
		this.events.onPermissionGranted(toolUseId);
		this.transitionTo({ kind: "tool_running", lease, toolName: tool, sawAssistantOutput: true });
		this.dequeueNextPermission();
	}

	private mintLease(): TurnLease {
		this.activeLease = ++this.leaseSeq;
		return this.activeLease;
	}

	private invalidateLease(): void {
		this.activeLease = 0;
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	private isLeaseValid(lease: TurnLease): boolean {
		return lease !== 0 && lease === this.activeLease && this.record !== null;
	}

	private transitionTo(next: TurnState): void {
		if (this.state.kind === next.kind && next.kind === "idle") {
			// Idempotent: already idle, nothing to broadcast.
			return;
		}
		if (!canTransition(this.state.kind, next.kind)) {
			logger.warn("turnCoordinator: invalid transition", { from: this.state.kind, to: next.kind });
			return;
		}
		this.state = next;
		this.events.onStateChange(next);
	}

	private async runTurn(
		record: SessionRecord,
		prompt: string,
		contextHashToCommit: string | undefined,
		lease: TurnLease,
		permissionModeOverride?: PermissionMode,
	): Promise<void> {
		this.transitionTo({ kind: "starting", lease });
		const controller = new AbortController();
		this.abortController = controller;

		let permissionDenialEvent: { tool: string; reason: string } | null = null;
		let lostSession = false;
		let sawSystemInit = false;
		let sawAssistantOutput = false;

		const onEvent = (event: StreamEvent) => {
			if (!this.isLeaseValid(lease) || this.record !== record) return;

			if (event.kind === "assistant_text" || event.kind === "assistant_text_delta" || event.kind === "tool_use") {
				sawAssistantOutput = true;
			}
			if (event.kind === "system_init" && !sawSystemInit) {
				sawSystemInit = true;
				this.transitionTo({ kind: "streaming", lease, sawAssistantOutput });
				if (!record.meta.id) {
					record.meta.id = event.sessionId;
				}
			}
			if (event.kind === "result" && event.permissionDenied) {
				permissionDenialEvent = event.permissionDenied;
			}
			if (event.kind === "result") {
				accumulateUsage(record, event.totalCostUsd, event.usage);
				this.events.onUsageChanged(record);
				// Project the next turn's prompt size — see projectedContextSize
				// for the formula. With prompt caching active, raw input_tokens
				// is just the post-breakpoint slice and is wildly low; the cache
				// reads ARE in the model's context.
				const projected = projectedContextSize(event.usage);
				if (projected > 0) {
					this.events.onContextWarn(record, projected);
				}
			}
			if (event.kind === "tool_use") {
				this.toolUseCountThisTurn++;
				// Claude emits all parallel tool_use blocks at once, even though
				// the CLI invokes their hooks sequentially. If we're currently
				// holding a permission prompt for an earlier tool, the user is
				// still deciding — don't override `awaiting_permission` with
				// `tool_running`, or decidePermission will reject the click.
				if (this.state.kind !== "awaiting_permission") {
					this.transitionTo({ kind: "tool_running", lease, toolName: event.name, sawAssistantOutput });
				}
			}
			if (event.kind === "stderr") {
				if (LOST_SESSION_PATTERN.test(event.line)) lostSession = true;
				this.recordDiagnostic(record, { ts: Date.now(), kind: "stderr", text: event.line });
			}
			if (event.kind === "result" && event.errors?.some((e) => LOST_SESSION_PATTERN.test(e))) {
				lostSession = true;
			}
			if (event.kind === "api_retry") {
				const status = event.errorStatus !== null ? ` (status ${event.errorStatus})` : "";
				this.recordDiagnostic(record, {
					ts: Date.now(),
					kind: "api_retry",
					text: `Retry ${event.attempt}/${event.maxRetries} in ${event.retryDelayMs}ms${status}`,
				});
			}
			this.events.onStreamEvent(event);
		};

		try {
			const result = await this.plugin.runner.send(
				this.composeSendOptions(record, prompt, controller.signal, onEvent, permissionModeOverride),
			);
			logger.log("turn complete", {
				exitCode: result.exitCode,
				stderrBytes: result.stderr.length,
				sawAssistantOutput,
			});

			if (!this.isLeaseValid(lease) || this.record !== record) {
				this.events.onTurnFinished({ kind: "stale" });
				return;
			}

			// TS doesn't narrow `let` mutated via closure; explicit cast.
			const denial = permissionDenialEvent as { tool: string; reason: string } | null;
			if (denial !== null && !controller.signal.aborted) {
				// `permission_denials` from a `result` event only fires when a tool
				// was blocked OUTSIDE the PreToolUse hook flow — i.e. by a settings
				// `permissions.deny` rule (the configDir safety nets). Those are
				// inviolable, so we surface a notice instead of asking the user to
				// override, then fall through to normal completion.
				const msg = `Tool "${denial.tool}" was blocked by a safety rule: ${denial.reason}`;
				new Notice(msg);
				this.events.onSystemNotice(msg);
				logger.warn("safety-rule denial", denial);
			}

			if (lostSession && record.meta.id && !controller.signal.aborted) {
				logger.warn("Claude lost track of the session; retrying without --resume");
				record.meta.id = undefined;
				this.events.onSystemNotice("Claude lost track of this session and started a new one.");
				await this.runTurn(record, prompt, contextHashToCommit, this.mintLease(), permissionModeOverride);
				return;
			}

			if (controller.signal.aborted) {
				this.transitionTo({ kind: "idle" });
				this.events.onTurnFinished({ kind: "aborted" });
				return;
			}

			// Surface failures we'd otherwise swallow into Idle.
			if (result.exitCode !== 0 || !sawAssistantOutput) {
				const stderr = result.stderr.trim();
				if (!stderr && sawAssistantOutput) {
					logger.warn("turn exited non-zero but rendered output", { exitCode: result.exitCode });
				} else {
					const msg = stderr
						? `Claude exited (${result.exitCode}): ${stderr.slice(-400)}`
						: result.exitCode !== 0
							? `Claude exited with code ${result.exitCode} and no output.`
							: "Claude returned no assistant message. Check the console with verbose logging on for details.";
					new Notice(msg);
					this.events.onSystemNotice(msg);
					logger.warn("turn produced no assistant output", { exitCode: result.exitCode, stderr });
				}
			}

			if (contextHashToCommit) {
				const ctx = this.getContext();
				if (ctx && ctx.contentHash === contextHashToCommit) {
					record.permissions.lastAttached = {
						path: ctx.path,
						contentHash: ctx.contentHash,
						kind: ctx.kind,
						range: ctx.range,
					};
				}
			}

			record.meta.updatedAt = Date.now();
			record.meta.lastTurnSummary = summarizeLastAssistantTurn(record);
			this.plugin.sessions.scheduleSave(record);
			this.transitionTo({ kind: "idle" });
			this.events.onTurnFinished({ kind: "completed" });
		} catch (e) {
			if (!this.isLeaseValid(lease) || this.record !== record) {
				this.events.onTurnFinished({ kind: "stale" });
				return;
			}
			const error = e instanceof Error ? e : new Error(String(e));
			if (error instanceof BinaryNotInstalledError) {
				new Notice("Install Claude Code from the plugin settings to start chatting.");
			} else {
				new Notice(`Claude Code error: ${error.message}`);
			}
			this.transitionTo({ kind: "error", lease, message: error.message });
			this.events.onTurnFinished({ kind: "error", error });
			logger.error("runTurn failed", e);
		} finally {
			if (this.abortController === controller) {
				this.abortController = null;
			}
		}
	}

	private composeSendOptions(
		record: SessionRecord,
		prompt: string,
		signal: AbortSignal,
		onEvent: (event: StreamEvent) => void,
		permissionModeOverride?: PermissionMode,
	): SendOptions {
		const paths = resolvePaths(this.plugin);
		const effectivePermissionMode = permissionModeOverride ?? this.plugin.settings.permissionMode;
		return {
			prompt,
			cwd: paths.vaultRoot,
			binaryPath: paths.binaryPath,
			configDir: paths.configDir,
			resumeSessionId: record.meta.id,
			permissionMode: effectivePermissionMode,
			model: this.plugin.settings.model || undefined,
			systemPromptAddendum: this.plugin.settings.systemPromptAddendum || undefined,
			settingsJson: buildSettingsJson({
				permissionMode: effectivePermissionMode,
				configDir: this.plugin.app.vault.configDir,
				hookCommand: buildHookCommand(paths.hookScriptPath),
			}),
			signal,
			onEvent,
		};
	}

	private recordDiagnostic(record: SessionRecord, entry: DiagnosticEntry): void {
		if (!record.diagnostics) record.diagnostics = [];
		record.diagnostics.push(entry);
		const overflow = record.diagnostics.length - MAX_DIAGNOSTICS_PER_SESSION;
		if (overflow > 0) record.diagnostics.splice(0, overflow);
		this.events.onDiagnostic(entry, record);
	}
}

function currentLease(state: TurnState): TurnLease | null {
	if (state.kind === "idle") return null;
	return state.lease;
}

// Mirrors the matching logic in HookServer.fastPath: list entries can be bare
// tool names ("Edit") or scoped patterns ("Bash(git *)"); we match on the head
// before the first paren.
function toolMatchesList(list: string[], tool: string): boolean {
	for (const entry of list) {
		const head = entry.split("(", 1)[0]?.trim() ?? entry.trim();
		if (head === tool) return true;
	}
	return false;
}

function accumulateUsage(record: SessionRecord, costUsd: number | undefined, usage: UsageInfo | undefined): void {
	if (!record.usage) {
		record.usage = {
			totalCostUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		};
	}
	if (typeof costUsd === "number") record.usage.totalCostUsd += costUsd;
	if (usage) {
		record.usage.inputTokens += usage.input_tokens ?? 0;
		record.usage.outputTokens += usage.output_tokens ?? 0;
		record.usage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
		record.usage.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
	}
}

