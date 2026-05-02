import { Notice } from "obsidian";
import { BinaryNotInstalledError } from "../binary/installer";
import { resolvePaths } from "../binary/paths";
import { buildSettingsJson } from "../cli/settingsJson";
import { MAX_DIAGNOSTICS_PER_SESSION } from "../constants";
import type { CapturedContext } from "../context/activeNote";
import type ClaudeCodePlugin from "../main";
import {
	ChatTurn,
	DiagnosticEntry,
	PermissionDecision,
	SendOptions,
	StreamEvent,
	UsageInfo,
} from "../types";
import * as logger from "../utils/log";
import { buildHookCommand } from "../permissions/hookCommandString";
import { applyDecision } from "./permissions";
import type { SessionRecord } from "./store";
import { ToolIndex } from "./toolIndex";
import { canTransition, TurnLease, TurnState } from "./turnState";

const LOST_SESSION_PATTERN = /session.*not\s*found|unknown\s*session|no\s*conversation\s*found/i;

export type TurnOutcome =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "error"; error: Error }
	| { kind: "denied_inline" }
	| { kind: "stale" };

export interface CoordinatorEvents {
	onStateChange(state: TurnState): void;
	onStreamEvent(event: StreamEvent): void;
	onDiagnostic(entry: DiagnosticEntry, record: SessionRecord): void;
	onUsageChanged(record: SessionRecord): void;
	onSystemNotice(message: string): void;
	onPermissionRequired(toolUseId: string): void;
	onPermissionGranted(toolUseId: string): void;
	onAborted(): void;
	onTurnFinished(outcome: TurnOutcome): void;
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
	 */
	private permissionQueue: Array<{ toolUseId: string; toolName: string }> = [];

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

	startTurn(prompt: string, contextHashToCommit: string | undefined): void {
		const record = this.record;
		if (!record) return;
		void this.runTurn(record, prompt, contextHashToCommit, this.mintLease());
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
			logger.log("[coord] beginHookWait: already awaiting, queueing", { toolUseId, queueLen: this.permissionQueue.length });
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
		logger.log("[coord] beginHookWait: opening prompt", { toolUseId });
		this.openPermissionPrompt(toolUseId, toolName, lease);
		return true;
	}

	private openPermissionPrompt(toolUseId: string, toolName: string, lease: TurnLease): void {
		this.transitionTo({
			kind: "awaiting_permission",
			lease,
			pending: {
				placeholderToolUseId: toolUseId,
				tool: toolName,
				// `hookId` is just a discriminator selecting the hook code path
				// in decidePermission; we reuse toolUseId since they're 1:1.
				hookId: toolUseId,
			},
		});
		this.events.onPermissionRequired(toolUseId);
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
		if (this.state.kind === "awaiting_permission") {
			const pending = this.state.pending;
			const record = this.record;
			if (record) {
				const block = this.toolIndex.resolve(record, pending.placeholderToolUseId);
				if (block) block.status = "denied";
			}
			this.plugin.hookServer.respond(pending.placeholderToolUseId, "deny", "Turn aborted");
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

		const block = this.toolIndex.resolve(record, toolUseId);
		if (!block) {
			logger.log("[coord] decidePermission: block missing", { toolUseId });
			return;
		}

		logger.log("[coord] decidePermission applying", { toolUseId, decision, tool: block.tool });
		await this.applyHookDecision(record, block.tool, toolUseId, decision, lease);
	}

	/**
	 * Hook flow: the CLI is paused inside the hook script. Write the response
	 * file via HookServer; the same turn continues — no resend, no abort.
	 */
	private async applyHookDecision(
		record: SessionRecord,
		tool: string,
		toolUseId: string,
		decision: PermissionDecision,
		lease: TurnLease,
	): Promise<void> {
		if (decision === "deny") {
			this.plugin.hookServer.respond(toolUseId, "deny", "User denied via Obsidian plugin");
			const denyBlock = this.toolIndex.resolve(record, toolUseId);
			if (denyBlock) denyBlock.status = "denied";
			this.plugin.sessions.scheduleSave(record);
			// "deny once" affects only this call; do NOT add to record.permissions.deniedTools
			// (that would be "deny always" semantics — out of scope for this prompt).
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
				this.plugin.hookServer.respond(toolUseId, "deny", "Session switched during decision");
				this.drainQueueWithDeny("Session switched during decision");
				return;
			}
		}
		this.plugin.sessions.scheduleSave(record);
		this.plugin.hookServer.respond(toolUseId, "allow");
		// CLI will continue and emit tool_result; the existing card flips back to running.
		const allowBlock = this.toolIndex.resolve(record, toolUseId);
		if (allowBlock) allowBlock.status = "running";
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
			}
			if (event.kind === "tool_use") {
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
				this.composeSendOptions(record, prompt, controller.signal, onEvent),
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
				await this.runTurn(record, prompt, contextHashToCommit, this.mintLease());
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
	): SendOptions {
		const paths = resolvePaths(this.plugin);
		return {
			prompt,
			cwd: paths.vaultRoot,
			binaryPath: paths.binaryPath,
			configDir: paths.configDir,
			resumeSessionId: record.meta.id,
			permissionMode: this.plugin.settings.permissionMode,
			model: this.plugin.settings.model || undefined,
			systemPromptAddendum: this.plugin.settings.systemPromptAddendum || undefined,
			settingsJson: buildSettingsJson({
				permissionMode: this.plugin.settings.permissionMode,
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

function summarizeLastAssistantTurn(record: SessionRecord): string | undefined {
	for (let i = record.turns.length - 1; i >= 0; i--) {
		const turn: ChatTurn | undefined = record.turns[i];
		if (!turn || turn.role !== "assistant") continue;
		for (const block of turn.blocks) {
			if (block.type === "text" && block.markdown.trim()) {
				const flat = block.markdown.replace(/\s+/g, " ").trim();
				const sentenceMatch = flat.match(/^.{1,140}?[.!?](?:\s|$)/);
				const summary = sentenceMatch ? sentenceMatch[0].trim() : flat.slice(0, 140);
				return summary.length > 140 ? summary.slice(0, 139) + "…" : summary;
			}
		}
		return undefined;
	}
	return undefined;
}
