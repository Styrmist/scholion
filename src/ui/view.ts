import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { resolvePaths } from "../binary/paths";
import { MentionCandidate, parseMentions } from "../composer/mentions";
import { captureActiveContext, CapturedContext, isMarkdownLike, truncate } from "../context/activeNote";
import { buildPrompt, shouldAttach } from "../context/promptBuilder";
import { VIEW_TYPE_CHAT, RIBBON_ICON } from "../constants";
import {
	checkCostGuard,
	CostGuardState,
	freshCostGuardState,
	markCapBypassed,
	markWarnDelivered,
} from "../session/costGuard";
import {
	buildForkedTurns,
	freshForkMeta,
	serializeInheritedTurns,
} from "../session/forking";
import { hashString } from "../utils/fs";
import type { SessionRecord } from "../session/store";
import { ToolIndex } from "../session/toolIndex";
import { CoordinatorEvents, TurnCoordinator, TurnOutcome } from "../session/turnCoordinator";
import { TurnState } from "../session/turnState";
import { ChatTurn } from "../types";
import type ClaudeCodePlugin from "../main";
import { Composer } from "./composer";
import { confirm } from "./confirmModal";
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
	/**
	 * Cost-guard state is per active record but transient: it does not survive
	 * a plugin reload, so a fresh session picks up its own warn/cap progress
	 * starting from the recorded total cost. WeakMap keys on the record so
	 * deletion is automatic when sessions are unloaded.
	 */
	private costGuardStates = new WeakMap<SessionRecord, CostGuardState>();

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
			onForkFromTurn: (turnIndex) => { void this.forkFromTurn(turnIndex); },
		});
		this.transcript.bindRecordRef(() => this.currentRecord);

		this.diagnosticsPanel = new DiagnosticsPanel(root, {
			onClear: () => this.clearDiagnostics(),
		});

		this.composer = new Composer(root, this.app, {
			onSubmit: ({ text, attachContext }) => { void this.handleSubmit(text, attachContext); },
			onAbort: () => this.coordinator.abort(),
			getSendMethod: () => this.plugin.settings.sendMethod,
			getMentionCandidates: () => this.collectMentionCandidates(),
			isMentionsEnabled: () => this.plugin.settings.enableMentions,
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
		// Stale-context defenses: a rename swaps the path under us (the captured
		// path becomes wrong); a delete removes the file (capture should fall
		// through to a different markdown leaf or null). Both fire vault events
		// that workspace `active-leaf-change` doesn't, so listen explicitly.
		this.registerEvent(
			this.app.vault.on("rename", () => { void this.refreshContext(); })
		);
		this.registerEvent(
			this.app.vault.on("delete", () => { void this.refreshContext(); })
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

		const guardOk = await this.runCostGuardCheck(record);
		if (!guardOk) return;

		const context = attachContext ? this.currentTurnContext : null;
		const previousHash = record.permissions.lastAttached?.contentHash;
		const willAttach = context !== null && shouldAttach(context, previousHash);
		const finalContext = willAttach ? context : null;
		const mentions = await this.materializeMentions(text, finalContext?.path ?? null);
		// Forked sessions include their inherited transcript on the first new
		// turn only — once the CLI hands us a session id we stop re-sending it.
		const inheritedConversation = this.shouldIncludeInheritedConversation(record)
			? serializeInheritedTurns(record.turns.slice(0, record.forkedFromTurns ?? 0))
			: undefined;
		const prompt = buildPrompt({
			userText: text,
			context: finalContext,
			mentions,
			inheritedConversation,
		});

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
				...mentions.map((m) => ({
					type: "context_attachment" as const,
					path: m.path,
					bytes: m.bytes,
					kind: m.kind,
				})),
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
			onPermissionRequired: (toolUseId, batched) =>
				this.transcript.requestPermissionFor(toolUseId, batched),
			onPermissionGranted: (toolUseId) => {
				// Card was created from the real tool_use event; keep it. CLI will
				// run the tool next and emit tool_result, which updates the card.
				this.transcript.setToolCardStatus(toolUseId, "running");
			},
			onAborted: () => this.transcript.markAborted(),
			onTurnFinished: (outcome) => this.handleTurnFinished(outcome),
			onCycleCapReached: ({ count, cap, onContinue, onStop }) => {
				this.transcript.appendInteractiveNotice({
					message: `Claude has used ${count} tool calls in this turn (cap: ${cap}). Continue or stop?`,
					actions: [
						{ label: "Continue", onClick: onContinue },
						{ label: "Stop", cls: "cc-perm__btn--danger", onClick: onStop },
					],
				});
			},
		};
	}

	/**
	 * Pre-submit cost-guard check. Returns false if the user should be blocked
	 * from sending (cap reached and not bypassed). Side-effects: shows a one-shot
	 * warn notice on first crossing of the warn threshold, opens a modal confirm
	 * on cap crossings to capture the bypass decision.
	 */
	private async runCostGuardCheck(record: SessionRecord): Promise<boolean> {
		const usage = record.usage;
		if (!usage) return true;
		const state = this.getCostGuardState(record);
		const result = checkCostGuard(
			usage.totalCostUsd,
			this.plugin.settings.costWarnUsd,
			this.plugin.settings.costHardCapUsd,
			state,
		);
		if (result.kind === "ok") return true;
		const cost = result.cost.toFixed(2);
		const threshold = result.threshold.toFixed(2);
		if (result.kind === "warn") {
			markWarnDelivered(state, result.threshold);
			this.transcript.appendSystemNotice(
				`Session cost has crossed $${threshold} (current $${cost}). Continuing.`,
			);
			return true;
		}
		const ok = await confirm(
			this.app,
			`This session has spent $${cost}, past your hard cap of $${threshold}. ` +
				`Send this message anyway? The cap will be bypassed for the rest of the session.`,
		);
		if (!ok) {
			new Notice("Send cancelled — session cost cap reached.");
			return false;
		}
		markCapBypassed(state);
		this.transcript.appendSystemNotice(
			`Cost cap of $${threshold} bypassed for this session.`,
		);
		return true;
	}

	private getCostGuardState(record: SessionRecord): CostGuardState {
		let state = this.costGuardStates.get(record);
		if (!state) {
			state = freshCostGuardState();
			this.costGuardStates.set(record, state);
		}
		return state;
	}

	/**
	 * List vault notes available for `@`-mention autocomplete. Sorted by mtime
	 * desc so recently edited notes show first when the query is empty.
	 */
	private collectMentionCandidates(): MentionCandidate[] {
		const files = this.app.vault.getMarkdownFiles();
		files.sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
		return files.map((f) => ({ basename: f.basename, path: f.path }));
	}

	/**
	 * Resolve `@[[Name]]` references in user text into capturable note content
	 * for the prompt. Skips: mentions whose name doesn't resolve, mentions
	 * pointing at the same path as the auto-attached active note (already in
	 * context), and non-markdown-like files. Reads with the same `maxAttachKB`
	 * cap as the auto-attach.
	 */
	private async materializeMentions(
		userText: string,
		activePath: string | null,
	): Promise<CapturedContext[]> {
		if (!this.plugin.settings.enableMentions) return [];
		const parsed = parseMentions(userText);
		if (parsed.length === 0) return [];
		const out: CapturedContext[] = [];
		const seenPaths = new Set<string>();
		if (activePath) seenPaths.add(activePath);
		for (const m of parsed) {
			const file = this.resolveMentionFile(m.name);
			if (!file) continue;
			if (seenPaths.has(file.path)) continue;
			if (!isMarkdownLike(file)) continue;
			const raw = await this.app.vault.cachedRead(file);
			const truncated = truncate(raw, this.plugin.settings.maxAttachKB);
			out.push({
				kind: "note",
				path: file.path,
				content: truncated.content,
				contentHash: hashString(`mention:${file.path}:${truncated.content}`),
				bytes: truncated.bytes,
				truncated: truncated.truncated,
			});
			seenPaths.add(file.path);
		}
		return out;
	}

	/**
	 * True when the next prompt for this record should carry its inherited
	 * conversation. The marker is a fork that has not yet completed a turn —
	 * the CLI session id arrives in `system_init`, meaning Claude has
	 * absorbed the inherited block, so we don't resend on subsequent turns.
	 */
	private shouldIncludeInheritedConversation(record: SessionRecord): boolean {
		if (record.forkedFromTurns === undefined) return false;
		if (record.forkedFromTurns <= 0) return false;
		// First turn in the fork: meta.id is still undefined (CLI hasn't
		// introduced itself yet).
		return !record.meta.id;
	}

	private async forkFromTurn(turnIndex: number): Promise<void> {
		const parent = this.currentRecord;
		if (!parent) return;
		if (this.coordinator.isBusy() || this.coordinator.isAwaitingPermission()) {
			new Notice("Finish or stop the current turn before forking.");
			return;
		}
		const turn = parent.turns[turnIndex];
		if (!turn) return;
		// Only allow forking off assistant turns for now — branching from a
		// user turn is meaningful too but its UX (drop-vs-keep that turn) is
		// a separate decision, parked for future work.
		if (turn.role !== "assistant") return;

		const { turns, forkedFromTurns } = buildForkedTurns({
			parentTurns: parent.turns,
			keepThroughIndex: turnIndex,
		});
		const meta = freshForkMeta(
			parent.meta,
			this.plugin.sessions.createMeta(parent.meta.cwd).localId,
			Date.now(),
		);
		const fork: SessionRecord = {
			meta,
			turns,
			permissions: {
				allowedTools: [...parent.permissions.allowedTools],
				deniedTools: [...parent.permissions.deniedTools],
			},
			forkedFromTurns,
		};
		await this.plugin.sessions.saveImmediate(fork);
		await this.swapToRecord(fork);
		new Notice(`Forked ${forkedFromTurns} turn${forkedFromTurns === 1 ? "" : "s"} into a new chat.`);
	}

	private async swapToRecord(record: SessionRecord): Promise<void> {
		this.currentRecord = record;
		this.coordinator.bindRecord(record);
		this.transcript.renderHistoricalTurns(record.turns);
		this.diagnosticsPanel.setEntries(record.diagnostics);
		this.statusPill.setUsage(record.usage ?? null);
		this.picker.setActive(record.meta);
		this.composer.focus();
		await this.refreshContext();
	}

	private resolveMentionFile(name: string): TFile | null {
		// Wikilink-style resolution first; falls back to a literal path lookup
		// for users who insert paths directly (e.g. by pasting).
		const linked = this.app.metadataCache.getFirstLinkpathDest(name, "");
		if (linked) return linked;
		const direct = this.app.vault.getAbstractFileByPath(name);
		if (direct instanceof TFile) return direct;
		const withMd = this.app.vault.getAbstractFileByPath(`${name}.md`);
		if (withMd instanceof TFile) return withMd;
		return null;
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
		// First completed turn after a fork: the CLI now owns the inherited
		// context, so the marker can drop. Clearing on any non-stale outcome
		// (including aborts) is fine because future turns will check `meta.id`
		// — if the CLI session id never landed, the inherited block will go
		// out again next send.
		const record = this.currentRecord;
		if (record && record.forkedFromTurns !== undefined && record.meta.id) {
			delete record.forkedFromTurns;
			this.plugin.sessions.scheduleSave(record);
		}
	}
}

function makeTitle(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= 60) return single;
	return single.slice(0, 57) + "…";
}
