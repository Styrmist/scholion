import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { resolvePaths } from "../binary/paths";
import { BinaryNotInstalledError } from "../binary/installer";
import { buildSettingsJson } from "../cli/settingsJson";
import { captureActiveContext, CapturedContext } from "../context/activeNote";
import { buildPrompt, shouldAttach } from "../context/promptBuilder";
import {
	MAX_DIAGNOSTICS_PER_SESSION,
	VIEW_TYPE_CHAT,
	RIBBON_ICON,
} from "../constants";
import { applyDecision } from "../session/permissions";
import type { SessionRecord } from "../session/store";
import {
	ChatTurn,
	DiagnosticEntry,
	PermissionDecision,
	SendOptions,
	StreamEvent,
	ToolBlock,
	UsageInfo,
} from "../types";
import * as logger from "../utils/log";
import type ClaudeCodePlugin from "../main";
import { Composer } from "./composer";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { SessionPicker } from "./sessionPicker";
import { StatusPill } from "./statusPill";
import { TranscriptView } from "./transcript";

const LOST_SESSION_PATTERN = /session.*not\s*found|unknown\s*session|no\s*conversation\s*found/i;

interface PendingPermissionState {
	placeholderToolUseId: string;
	prompt: string;
	contextHashToCommit?: string;
}

export class ChatView extends ItemView {
	private statusPill!: StatusPill;
	private transcript!: TranscriptView;
	private diagnosticsPanel!: DiagnosticsPanel;
	private composer!: Composer;
	private picker!: SessionPicker;
	private currentRecord: SessionRecord | null = null;
	private abortController: AbortController | null = null;
	private currentTurnContext: CapturedContext | null = null;
	private pendingPermission: PendingPermissionState | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ClaudeCodePlugin) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_CHAT; }
	getDisplayText(): string { return "Claude Code"; }
	getIcon(): string { return RIBBON_ICON; }

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("cc-view");

		const header = root.createDiv({ cls: "cc-header" });
		this.picker = new SessionPicker(this.app, header, () => this.plugin.sessions.list(), {
			onNewChat: () => { void this.startNewChat(); },
			onSelect: (localId) => { void this.loadSession(localId); },
			onRename: (localId, title) => {
				void this.plugin.sessions.rename(localId, title).then(() => this.refreshPicker());
			},
			onDelete: (localId) => { void this.handleDelete(localId); },
		});
		this.statusPill = new StatusPill(header);

		const transcriptEl = root.createDiv({ cls: "cc-transcript" });
		this.transcript = new TranscriptView(this.plugin, this, transcriptEl, {
			onPermissionRequested: (toolUseId, decision) => {
				void this.handlePermissionDecision(toolUseId, decision);
			},
		});

		this.diagnosticsPanel = new DiagnosticsPanel(root, {
			onClear: () => this.clearDiagnostics(),
		});

		this.composer = new Composer(root, this.app, {
			onSubmit: ({ text, attachContext }) => { void this.handleSubmit(text, attachContext); },
			onAbort: () => this.abortCurrent(),
			getSendMethod: () => this.plugin.settings.sendMethod,
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => { void this.refreshContext(); })
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => { void this.refreshContext(); })
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => { void this.refreshContext(); })
		);

		await this.refreshContext();
		await this.startNewChat();
	}

	async onClose(): Promise<void> {
		this.abortCurrent();
		this.composer?.dispose();
		await this.plugin.sessions.flushAll();
	}

	refreshComposerHints(): void {
		this.composer?.refreshPlaceholder();
	}

	async startNewChat(): Promise<void> {
		// Stop any in-flight turn before swapping the record.
		this.abortCurrent();
		this.pendingPermission = null;
		const cwd = resolvePaths(this.plugin).vaultRoot;
		const meta = this.plugin.sessions.createMeta(cwd);
		const record: SessionRecord = {
			meta,
			turns: [],
			permissions: {
				allowedTools: [...this.plugin.settings.allowedTools],
				deniedTools: [...this.plugin.settings.disallowedTools],
			},
		};
		// Defer the first save until the user actually sends a message (handleSubmit).
		// Empty new chats don't clutter the picker; switching away discards them.
		this.currentRecord = record;
		this.transcript.clear();
		this.diagnosticsPanel.setEntries(record.diagnostics);
		this.statusPill.setUsage(record.usage ?? null);
		this.picker.setActive(meta);
		this.statusPill.set({ kind: "idle" });
		this.composer.setBusy(false);
		this.composer.focus();
		await this.refreshContext();
	}

	private async loadSession(localId: string): Promise<void> {
		const record = await this.plugin.sessions.load(localId);
		if (!record) {
			new Notice("Could not load that chat.");
			return;
		}
		// Stop any in-flight turn before swapping the record.
		this.abortCurrent();
		this.pendingPermission = null;
		this.currentRecord = record;
		this.picker.setActive(record.meta);
		this.transcript.renderHistoricalTurns(record.turns);
		this.diagnosticsPanel.setEntries(record.diagnostics);
		this.statusPill.setUsage(record.usage ?? null);
		this.statusPill.set({ kind: "idle" });
		this.composer.setBusy(false);
		this.composer.focus();
		await this.refreshContext();
	}

	private clearDiagnostics(): void {
		const record = this.currentRecord;
		if (!record) return;
		record.diagnostics = [];
		this.diagnosticsPanel.setEntries(record.diagnostics);
		this.plugin.sessions.scheduleSave(record);
	}

	private recordDiagnostic(record: SessionRecord, entry: DiagnosticEntry): void {
		if (!record.diagnostics) record.diagnostics = [];
		record.diagnostics.push(entry);
		const overflow = record.diagnostics.length - MAX_DIAGNOSTICS_PER_SESSION;
		if (overflow > 0) record.diagnostics.splice(0, overflow);
		if (this.currentRecord === record) this.diagnosticsPanel.append(entry);
	}

	private async handleDelete(localId: string): Promise<void> {
		await this.plugin.sessions.delete(localId);
		if (this.currentRecord?.meta.localId === localId) {
			await this.startNewChat();
		} else {
			this.refreshPicker();
		}
	}

	private refreshPicker(): void {
		this.picker.setActive(this.currentRecord?.meta ?? null);
	}

	private async refreshContext(): Promise<void> {
		if (!this.plugin.settings.autoAttachActiveNote) {
			this.currentTurnContext = null;
			this.composer.updateContext(null, false);
			return;
		}
		const context = await captureActiveContext(this.app, {
			preferSelection: this.plugin.settings.preferSelection,
			maxAttachKB: this.plugin.settings.maxAttachKB,
		});
		this.currentTurnContext = context;
		const previousHash = this.currentRecord?.permissions.lastAttached?.contentHash;
		const wouldAttach = shouldAttach(context, previousHash);
		this.composer.updateContext(context, !wouldAttach && Boolean(context));
	}

	private async handleSubmit(text: string, attachContext: boolean): Promise<void> {
		if (!this.currentRecord) return;
		// Block new submissions while a permission decision is awaited.
		if (this.pendingPermission) {
			new Notice("Resolve the pending permission prompt first.");
			return;
		}
		const record = this.currentRecord;

		const context = attachContext ? this.currentTurnContext : null;
		const previousHash = record.permissions.lastAttached?.contentHash;
		const willAttach = context !== null && shouldAttach(context, previousHash);
		const finalContext = willAttach ? context : null;
		const prompt = buildPrompt({ userText: text, context: finalContext });

		const userTurn: ChatTurn = {
			role: "user",
			startedAt: Date.now(),
			blocks: [
				...(finalContext
					? [{
						type: "context_attachment" as const,
						path: finalContext.path,
						bytes: finalContext.bytes,
						kind: finalContext.kind,
					}]
					: []),
				{ type: "text" as const, markdown: text },
			],
		};
		record.turns.push(userTurn);
		this.transcript.appendUserTurn(userTurn);

		if (record.turns.length === 1) {
			record.meta.title = makeTitle(text);
			record.meta.updatedAt = Date.now();
			// First user message: register the session in the picker and on disk.
			await this.plugin.sessions.saveImmediate(record);
			this.picker.setActive(record.meta);
		}

		const assistantTurn: ChatTurn = {
			role: "assistant",
			startedAt: Date.now(),
			blocks: [],
		};
		record.turns.push(assistantTurn);
		this.transcript.beginAssistantTurn(assistantTurn);

		const contextHashToCommit = finalContext?.contentHash;
		await this.runTurn(record, prompt, contextHashToCommit);
	}

	private async runTurn(
		record: SessionRecord,
		prompt: string,
		contextHashToCommit?: string
	): Promise<void> {
		this.composer.setBusy(true);
		this.statusPill.set({ kind: "thinking", label: "Starting Claude…" });
		this.abortController = new AbortController();
		const turnRecord = record;

		let permissionDenialEvent: { tool: string; reason: string } | null = null;
		let lostSession = false;
		const sawSystemInit = { value: false };

		const onEvent = (event: StreamEvent) => {
			// Drop events from a stale run if the user switched sessions mid-turn.
			if (this.currentRecord !== turnRecord) return;

			if (event.kind === "system_init" && !sawSystemInit.value) {
				sawSystemInit.value = true;
				this.statusPill.set({ kind: "thinking" });
				if (!turnRecord.meta.id) {
					turnRecord.meta.id = event.sessionId;
				}
			}
			if (event.kind === "result" && event.permissionDenied) {
				permissionDenialEvent = event.permissionDenied;
			}
			if (event.kind === "result") {
				accumulateUsage(turnRecord, event.totalCostUsd, event.usage);
				this.statusPill.setUsage(turnRecord.usage ?? null);
			}
			if (event.kind === "tool_use") this.statusPill.set({ kind: "tool", label: `Tool: ${event.name}` });
			if (event.kind === "stderr") {
				if (LOST_SESSION_PATTERN.test(event.line)) lostSession = true;
				this.recordDiagnostic(turnRecord, { ts: Date.now(), kind: "stderr", text: event.line });
			}
			if (event.kind === "result" && event.errors?.some((e) => LOST_SESSION_PATTERN.test(e))) {
				lostSession = true;
			}
			if (event.kind === "api_retry") {
				const status = event.errorStatus !== null ? ` (status ${event.errorStatus})` : "";
				this.recordDiagnostic(turnRecord, {
					ts: Date.now(),
					kind: "api_retry",
					text: `Retry ${event.attempt}/${event.maxRetries} in ${event.retryDelayMs}ms${status}`,
				});
			}
			this.transcript.handleEvent(event);
		};

		let sawAssistantOutput = false;
		const onEventWrapped = (event: StreamEvent) => {
			if (event.kind === "assistant_text" || event.kind === "assistant_text_delta" || event.kind === "tool_use") {
				sawAssistantOutput = true;
			}
			onEvent(event);
		};

		try {
			const result = await this.plugin.runner.send(
				this.composeSendOptions(turnRecord, prompt, this.abortController.signal, onEventWrapped)
			);
			logger.log("turn complete", { exitCode: result.exitCode, stderrBytes: result.stderr.length, sawAssistantOutput });

			if (this.currentRecord !== turnRecord) {
				// User switched sessions; don't update UI for the stale turn.
				return;
			}

			if (permissionDenialEvent && !this.abortController.signal.aborted) {
				this.handleInlineDenial(turnRecord, prompt, permissionDenialEvent, contextHashToCommit);
				return;
			}

			if (lostSession && turnRecord.meta.id && !this.abortController.signal.aborted) {
				logger.warn("Claude lost track of the session; retrying without --resume");
				turnRecord.meta.id = undefined;
				this.transcript.appendSystemNotice("Claude lost track of this session and started a new one.");
				await this.runTurn(turnRecord, prompt, contextHashToCommit);
				return;
			}

			// Surface failures we'd otherwise swallow into Idle.
			if (result.exitCode !== 0 || (!sawAssistantOutput && !this.abortController.signal.aborted)) {
				const stderr = result.stderr.trim();
				// If the assistant already rendered something (e.g. an API error message
				// the CLI surfaces as text), skip the redundant "exited / no output" notice.
				if (!stderr && sawAssistantOutput) {
					logger.warn("turn exited non-zero but rendered output", { exitCode: result.exitCode });
				} else {
					const msg = stderr
						? `Claude exited (${result.exitCode}): ${stderr.slice(-400)}`
						: result.exitCode !== 0
							? `Claude exited with code ${result.exitCode} and no output.`
							: "Claude returned no assistant message. Check the console with verbose logging on for details.";
					new Notice(msg);
					this.transcript.appendSystemNotice(msg);
					logger.warn("turn produced no assistant output", { exitCode: result.exitCode, stderr });
				}
			}

			if (!this.abortController.signal.aborted && contextHashToCommit) {
				const ctx = this.currentTurnContext;
				if (ctx && ctx.contentHash === contextHashToCommit) {
					turnRecord.permissions.lastAttached = {
						path: ctx.path,
						contentHash: ctx.contentHash,
						kind: ctx.kind,
						range: ctx.range,
					};
				}
			}

			turnRecord.meta.updatedAt = Date.now();
			turnRecord.meta.lastTurnSummary = summarizeLastAssistantTurn(turnRecord);
			this.plugin.sessions.scheduleSave(turnRecord);
			this.transcript.finalizeTurn();
			this.statusPill.set({ kind: "idle" });
		} catch (e) {
			if (this.currentRecord !== turnRecord) return;
			if (e instanceof BinaryNotInstalledError) {
				new Notice("Install Claude Code from the plugin settings to start chatting.");
			} else {
				new Notice(`Claude Code error: ${(e as Error).message}`);
			}
			this.statusPill.set({ kind: "error", label: (e as Error).message });
			this.transcript.finalizeTurn();
			logger.error("runTurn failed", e);
		} finally {
			this.abortController = null;
			if (!this.pendingPermission && this.currentRecord === turnRecord) {
				this.composer.setBusy(false);
				void this.refreshContext();
			}
		}
	}

	private composeSendOptions(
		record: SessionRecord,
		prompt: string,
		signal: AbortSignal,
		onEvent: (event: StreamEvent) => void
	): SendOptions {
		const paths = resolvePaths(this.plugin);
		return {
			prompt,
			cwd: paths.vaultRoot,
			binaryPath: paths.binaryPath,
			configDir: paths.configDir,
			resumeSessionId: record.meta.id,
			allowedTools: record.permissions.allowedTools,
			disallowedTools: record.permissions.deniedTools,
			permissionMode: this.plugin.settings.permissionMode,
			model: this.plugin.settings.model || undefined,
			systemPromptAddendum: this.plugin.settings.systemPromptAddendum || undefined,
			settingsJson: buildSettingsJson({
				permissionMode: this.plugin.settings.permissionMode,
				configDir: this.plugin.app.vault.configDir,
			}),
			signal,
			onEvent,
		};
	}

	private handleInlineDenial(
		record: SessionRecord,
		prompt: string,
		denial: { tool: string; reason: string },
		contextHashToCommit?: string
	): void {
		const lastTurn = record.turns[record.turns.length - 1];
		if (!lastTurn || lastTurn.role !== "assistant") return;
		const placeholderId = `denial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const block: ToolBlock = {
			type: "tool",
			toolUseId: placeholderId,
			tool: denial.tool,
			input: { reason: denial.reason },
			status: "pending_permission",
		};
		lastTurn.blocks.push(block);
		this.transcript.handleEvent({
			kind: "tool_use",
			id: placeholderId,
			name: denial.tool,
			input: { reason: denial.reason },
		});
		this.transcript.requestPermissionFor(placeholderId);
		this.statusPill.set({ kind: "permission" });
		this.pendingPermission = {
			placeholderToolUseId: placeholderId,
			prompt,
			contextHashToCommit,
		};
		// Composer stays disabled while we wait for the user.
		this.composer.setBusy(true);
	}

	private async handlePermissionDecision(toolUseId: string, decision: PermissionDecision): Promise<void> {
		const record = this.currentRecord;
		const pending = this.pendingPermission;
		if (!record || !pending || pending.placeholderToolUseId !== toolUseId) return;
		const block = findToolBlock(record, toolUseId);
		if (!block) return;

		this.pendingPermission = null;

		if (decision === "deny") {
			block.status = "denied";
			this.transcript.finalizeTurn();
			this.statusPill.set({ kind: "idle" });
			this.plugin.sessions.scheduleSave(record);
			this.composer.setBusy(false);
			void this.refreshContext();
			return;
		}

		// Remove the placeholder block + card; the resend will produce real tool_use events.
		removeToolBlock(record, toolUseId);
		this.transcript.removeToolCard(toolUseId);

		record.permissions = applyDecision(record.permissions, block.tool, decision);
		if (decision === "global") {
			if (!this.plugin.settings.allowedTools.includes(block.tool)) {
				this.plugin.settings.allowedTools.push(block.tool);
			}
			this.plugin.settings.disallowedTools = this.plugin.settings.disallowedTools.filter((t) => t !== block.tool);
			await this.plugin.saveSettings();
		}
		this.plugin.sessions.scheduleSave(record);

		await this.runTurn(record, pending.prompt, pending.contextHashToCommit);
	}

	private abortCurrent(): void {
		if (this.pendingPermission) {
			const id = this.pendingPermission.placeholderToolUseId;
			const record = this.currentRecord;
			if (record) {
				const block = findToolBlock(record, id);
				if (block) block.status = "denied";
			}
			this.transcript.removeToolCard(id);
			this.pendingPermission = null;
		}
		if (!this.abortController) return;
		this.abortController.abort();
		this.transcript.markAborted();
	}
}

function makeTitle(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= 60) return single;
	return single.slice(0, 57) + "…";
}

function summarizeLastAssistantTurn(record: SessionRecord): string | undefined {
	for (let i = record.turns.length - 1; i >= 0; i--) {
		const turn = record.turns[i];
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

function findToolBlock(record: SessionRecord, toolUseId: string): ToolBlock | null {
	for (const turn of record.turns) {
		for (const block of turn.blocks) {
			if (block.type === "tool" && block.toolUseId === toolUseId) return block;
		}
	}
	return null;
}

function removeToolBlock(record: SessionRecord, toolUseId: string): void {
	for (const turn of record.turns) {
		const idx = turn.blocks.findIndex((b) => b.type === "tool" && b.toolUseId === toolUseId);
		if (idx >= 0) {
			turn.blocks.splice(idx, 1);
			return;
		}
	}
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
