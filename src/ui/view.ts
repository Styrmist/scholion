import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { resolvePaths } from "../binary/paths";
import { captureActiveContext, CapturedContext } from "../context/activeNote";
import { buildPrompt, shouldAttach } from "../context/promptBuilder";
import { VIEW_TYPE_CHAT, RIBBON_ICON } from "../constants";
import type { SessionRecord } from "../session/store";
import { ToolIndex } from "../session/toolIndex";
import { CoordinatorEvents, TurnCoordinator, TurnOutcome } from "../session/turnCoordinator";
import { TurnState } from "../session/turnState";
import { ChatTurn } from "../types";
import type ClaudeCodePlugin from "../main";
import { Composer } from "./composer";
import { DiagnosticsPanel } from "./diagnosticsPanel";
import { SessionPicker } from "./sessionPicker";
import { StatusPill } from "./statusPill";
import { TranscriptView } from "./transcript";

export class ChatView extends ItemView {
	private statusPill!: StatusPill;
	private transcript!: TranscriptView;
	private diagnosticsPanel!: DiagnosticsPanel;
	private composer!: Composer;
	private picker!: SessionPicker;
	private currentRecord: SessionRecord | null = null;
	private currentTurnContext: CapturedContext | null = null;
	private toolIndex = new ToolIndex();
	private coordinator!: TurnCoordinator;

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
		this.transcript = new TranscriptView(this.plugin, this, transcriptEl, this.toolIndex, {
			onPermissionRequested: (toolUseId, decision) => {
				void this.coordinator.decidePermission(toolUseId, decision);
			},
		});
		this.transcript.bindRecordRef(() => this.currentRecord);

		this.diagnosticsPanel = new DiagnosticsPanel(root, {
			onClear: () => this.clearDiagnostics(),
		});

		this.composer = new Composer(root, this.app, {
			onSubmit: ({ text, attachContext }) => { void this.handleSubmit(text, attachContext); },
			onAbort: () => this.coordinator.abort(),
			getSendMethod: () => this.plugin.settings.sendMethod,
		});

		this.coordinator = new TurnCoordinator(
			this.plugin,
			this.toolIndex,
			() => this.currentTurnContext,
			this.coordinatorEvents(),
		);
		this.plugin.hookServer.bindContext(
			{
				getRecord: () => this.currentRecord,
				getGlobalAllowed: () => this.plugin.settings.allowedTools,
				getGlobalDenied: () => this.plugin.settings.disallowedTools,
			},
			{
				requestDecision: (request) =>
					this.coordinator.beginHookWait(request.tool_use_id, request.tool_name),
			},
		);

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
		this.coordinator?.bindRecord(null);
		this.plugin.hookServer?.clearContext();
		this.composer?.dispose();
		await this.plugin.sessions.flushAll();
	}

	refreshComposerHints(): void {
		this.composer?.refreshPlaceholder();
	}

	async startNewChat(): Promise<void> {
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
		this.coordinator.bindRecord(record);
		this.transcript.clear();
		this.diagnosticsPanel.setEntries(record.diagnostics);
		this.statusPill.setUsage(record.usage ?? null);
		this.picker.setActive(meta);
		this.composer.focus();
		await this.refreshContext();
	}

	private async loadSession(localId: string): Promise<void> {
		const record = await this.plugin.sessions.load(localId);
		if (!record) {
			new Notice("Could not load that chat.");
			return;
		}
		this.currentRecord = record;
		this.coordinator.bindRecord(record);
		this.picker.setActive(record.meta);
		this.transcript.renderHistoricalTurns(record.turns);
		this.diagnosticsPanel.setEntries(record.diagnostics);
		this.statusPill.setUsage(record.usage ?? null);
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
		if (this.coordinator.isAwaitingPermission()) {
			new Notice("Resolve the pending permission prompt first.");
			return;
		}
		if (this.coordinator.isBusy()) return;
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
		this.transcript.beginAssistantTurn(assistantTurn, record.turns.length - 1);

		this.coordinator.startTurn(prompt, finalContext?.contentHash);
	}

	private coordinatorEvents(): CoordinatorEvents {
		return {
			onStateChange: (state) => this.applyTurnState(state),
			onStreamEvent: (event) => this.transcript.handleEvent(event),
			onDiagnostic: (entry, record) => {
				if (this.currentRecord === record) this.diagnosticsPanel.append(entry);
			},
			onUsageChanged: (record) => {
				if (this.currentRecord === record) this.statusPill.setUsage(record.usage ?? null);
			},
			onSystemNotice: (msg) => this.transcript.appendSystemNotice(msg),
			onPermissionRequired: (toolUseId) => this.transcript.requestPermissionFor(toolUseId),
			onPermissionGranted: (toolUseId) => {
				// Card was created from the real tool_use event; keep it. CLI will
				// run the tool next and emit tool_result, which updates the card.
				this.transcript.setToolCardStatus(toolUseId, "running");
			},
			onAborted: () => this.transcript.markAborted(),
			onTurnFinished: (outcome) => this.handleTurnFinished(outcome),
		};
	}

	private applyTurnState(state: TurnState): void {
		switch (state.kind) {
			case "idle":
				this.statusPill.set({ kind: "idle" });
				this.composer.setBusy(false);
				break;
			case "starting":
				this.statusPill.set({ kind: "thinking", label: "Starting Claude…" });
				this.composer.setBusy(true);
				break;
			case "streaming":
				this.statusPill.set({ kind: "thinking" });
				this.composer.setBusy(true);
				break;
			case "tool_running":
				this.statusPill.set({ kind: "tool", label: `Tool: ${state.toolName}` });
				this.composer.setBusy(true);
				break;
			case "awaiting_permission":
				this.statusPill.set({ kind: "permission" });
				this.composer.setBusy(true);
				break;
			case "aborting":
				this.composer.setBusy(true);
				break;
			case "error":
				this.statusPill.set({ kind: "error", label: state.message });
				this.composer.setBusy(false);
				break;
		}
	}

	private handleTurnFinished(outcome: TurnOutcome): void {
		if (outcome.kind === "stale") return;
		this.transcript.finalizeTurn();
		if (outcome.kind === "completed" || outcome.kind === "aborted" || outcome.kind === "denied_inline" || outcome.kind === "error") {
			void this.refreshContext();
		}
	}
}

function makeTitle(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= 60) return single;
	return single.slice(0, 57) + "…";
}
