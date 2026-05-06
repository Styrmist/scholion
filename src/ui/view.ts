import { FileSystemAdapter, ItemView, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { resolvePaths } from "../binary/paths";
import { MentionCandidate, parseMentions } from "../composer/mentions";
import {
	isKnownSlashCommandInvocation,
	mergeWithBuiltins,
	SlashCommand,
} from "../composer/slashCommands";
import { discoverSlashCommandsForVault } from "../composer/slashCommandsFs";
import { captureActiveContext, CapturedContext, isMarkdownLike, truncate } from "../context/activeNote";
import { buildPrompt, shouldAttach } from "../context/promptBuilder";
import { VIEW_TYPE_CHAT, RIBBON_ICON } from "../constants";
import {
	checkContextWarn,
	ContextWarnState,
	freshContextWarnState,
	markContextWarnDelivered,
} from "../session/contextWarn";
import {
	checkCostGuard,
	CostGuardState,
	freshCostGuardState,
	markCapBypassed,
	markWarnDelivered,
} from "../session/costGuard";
import {
	defaultExportFilename,
	formatTranscriptAsMarkdown,
	normalizeExportPath,
} from "../session/exportMarkdown";
import {
	buildForkedTurns,
	freshForkMeta,
	serializeInheritedTurns,
} from "../session/forking";
import { heuristicTitle } from "../session/titleClean";
import { formatTokens } from "../utils/format";
import { hashString } from "../utils/fs";
import type { SessionRecord } from "../session/store";
import { ToolIndex } from "../session/toolIndex";
import { CoordinatorEvents, TurnCoordinator, TurnOutcome } from "../session/turnCoordinator";
import { TurnState } from "../session/turnState";
import { ChatTurn } from "../types";
import type ClaudeCodePlugin from "../main";
import { Composer } from "./composer";
import { confirm, prompt } from "./confirmModal";
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
	/**
	 * Context-warn state per record (mirrors costGuardStates). Tracks the
	 * threshold last warned at so we don't re-fire every turn past 80%.
	 */
	private contextWarnStates = new WeakMap<SessionRecord, ContextWarnState>();
	/** Per-session plan-mode override. One-shot: resets to false after the plan-mode turn finishes. In-memory. */
	private planModeOn = false;
	/** Tracks whether the current in-flight turn was started in plan mode, so handleTurnFinished knows to reset the toggle. */
	private currentTurnUsedPlanMode = false;
	/** In-memory snapshot of `.claude/commands/` discovery, refreshed lazily. */
	private slashCommandsCache: SlashCommand[] = [];
	/** Timestamp the cache was last refreshed. 0 = never. */
	private slashCommandsCacheAt = 0;
	/** True while a refresh is already inflight (we don't want to thrash on rapid keystrokes). */
	private slashCommandsRefreshing = false;

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
			onExport: (localId) => { void this.handleExport(localId); },
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
			getSlashCommandCandidates: () => this.collectSlashCommandCandidates(),
			isSlashCommandsEnabled: () => this.plugin.settings.enableSlashCommands,
			onTogglePlanMode: () => { this.planModeOn = !this.planModeOn; },
			isPlanModeOn: () => this.planModeOn,
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
		// Kick off a background slash-command discovery so the popup has data
		// the first time the user types `/`. Cheap and best-effort.
		void this.refreshSlashCommandsCache();
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
		this.planModeOn = false;
		this.composer.refreshPlanModeBtn();
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
		this.planModeOn = false;
		this.composer.refreshPlanModeBtn();
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

	private async handleExport(localId: string): Promise<void> {
		// Always reload from disk: the active record's pending writes may not
		// have been flushed yet, and exporting a different session needs the
		// load anyway. SessionStore.flushAll first so what the user sees in
		// the chat matches what lands in the note.
		await this.plugin.sessions.flushAll();
		const record = await this.plugin.sessions.load(localId);
		if (!record) {
			new Notice("Could not load that chat.");
			return;
		}
		const initial = defaultExportFilename(record.meta, Date.now());
		const chosen = await prompt(this.app, "Export chat to note", initial);
		if (chosen === null) return;
		const target = normalizeExportPath(chosen);
		if (!target) {
			new Notice("Please choose a non-empty path ending in .md");
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(target);
		if (existing instanceof TFile) {
			const ok = await confirm(this.app, `${target} already exists. Overwrite?`);
			if (!ok) return;
		} else if (existing) {
			new Notice(`${target} is a folder, not a file. Pick a different path.`);
			return;
		}
		const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
		if (folder) {
			const folderFile = this.app.vault.getAbstractFileByPath(folder);
			if (!folderFile) {
				try { await this.app.vault.createFolder(folder); } catch (e) {
					new Notice(`Could not create folder ${folder}: ${(e as Error).message}`);
					return;
				}
			} else if (!(folderFile instanceof TFolder)) {
				new Notice(`${folder} is not a folder.`);
				return;
			}
		}
		const body = formatTranscriptAsMarkdown(record);
		try {
			let file: TFile;
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, body);
				file = existing;
			} else {
				file = await this.app.vault.create(target, body);
			}
			new Notice(`Exported to ${file.path}`);
			await this.app.workspace.getLeaf(true).openFile(file);
		} catch (e) {
			new Notice(`Export failed: ${(e as Error).message}`);
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

		// If the user is invoking a known slash command, send the message raw
		// (no `<user_message>` wrapping, no context attachments). The CLI
		// only intercepts slash commands when the message starts with
		// `/<name>` literally — wrapping kills interception and the message
		// gets forwarded to Claude as plain text instead.
		const knownNames = new Set(this.slashCommandsCache.map((c) => c.name));
		const isSlashInvocation = this.plugin.settings.enableSlashCommands
			&& isKnownSlashCommandInvocation(text, knownNames) !== null;

		const context = !isSlashInvocation && attachContext ? this.currentTurnContext : null;
		const previousHash = record.permissions.lastAttached?.contentHash;
		const willAttach = context !== null && shouldAttach(context, previousHash);
		const finalContext = willAttach ? context : null;
		const mentions = isSlashInvocation
			? []
			: await this.materializeMentions(text, finalContext?.path ?? null);
		// Forked sessions include their inherited transcript on the first new
		// turn only — once the CLI hands us a session id we stop re-sending it.
		// Slash commands skip this too: they're meta-actions, not conversation.
		const inheritedConversation = !isSlashInvocation && this.shouldIncludeInheritedConversation(record)
			? serializeInheritedTurns(record.turns.slice(0, record.forkedFromTurns ?? 0))
			: undefined;
		const prompt = isSlashInvocation
			? text
			: buildPrompt({
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
			record.meta.title = heuristicTitle(text);
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

		this.currentTurnUsedPlanMode = this.planModeOn;
		this.coordinator.startTurn(prompt, finalContext?.contentHash, {
			permissionMode: this.planModeOn ? "plan" : undefined,
		});
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
			onContextWarn: (record, projectedNextTurnTokens) => {
				if (this.currentRecord !== record) return;
				const state = this.getContextWarnState(record);
				const result = checkContextWarn(
					projectedNextTurnTokens,
					this.plugin.settings.modelContextSize,
					this.plugin.settings.contextWarnPercent,
					state,
				);
				if (result.kind !== "warn") return;
				markContextWarnDelivered(state, result.thresholdTokens);
				const usedFmt = formatTokens(result.usedTokens);
				const thresholdFmt = formatTokens(result.thresholdTokens);
				const sizeFmt = formatTokens(this.plugin.settings.modelContextSize);
				const message = `Next turn projected at ~${usedFmt} tokens — past the ${result.percent}% mark of the ${sizeFmt} context window (threshold ${thresholdFmt}). Consider /compact, forking, or starting a new chat soon.`;
				// Dual surface: transcript notice for the historical record,
				// Notice toast so the user actually sees it. The transcript
				// alone reads as a small muted line — easy to miss in a long
				// chat.
				this.transcript.appendSystemNotice(message);
				new Notice(message, 8000);
			},
		};
	}

	private getContextWarnState(record: SessionRecord): ContextWarnState {
		let state = this.contextWarnStates.get(record);
		if (!state) {
			state = freshContextWarnState();
			this.contextWarnStates.set(record, state);
		}
		return state;
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
	 * Returns the cached slash-command snapshot synchronously and kicks off
	 * a background refresh if the cache is older than 30s. The composer
	 * polls this on every keystroke; doing the I/O lazily (and never on the
	 * hot path) keeps typing snappy even on slow disks.
	 */
	private collectSlashCommandCandidates(): SlashCommand[] {
		const SLASH_CACHE_TTL_MS = 30_000;
		if (Date.now() - this.slashCommandsCacheAt > SLASH_CACHE_TTL_MS) {
			void this.refreshSlashCommandsCache();
		}
		return this.slashCommandsCache;
	}

	private async refreshSlashCommandsCache(): Promise<void> {
		if (this.slashCommandsRefreshing) return;
		this.slashCommandsRefreshing = true;
		try {
			const adapter = this.app.vault.adapter;
			const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
			let fsCommands: SlashCommand[] = [];
			if (vaultRoot) {
				try { fsCommands = await discoverSlashCommandsForVault(vaultRoot); } catch { /* best-effort */ }
			}
			// Built-ins always show, even when fs discovery is empty or fails.
			this.slashCommandsCache = mergeWithBuiltins(fsCommands);
			this.slashCommandsCacheAt = Date.now();
		} finally {
			this.slashCommandsRefreshing = false;
		}
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
		this.planModeOn = false;
		this.composer.refreshPlanModeBtn();
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
		// Plan mode is one-shot per use: after a turn that ran in plan mode
		// settles (Claude proposed a plan and the user approved/rejected, or
		// the turn errored/aborted), flip the toggle back off so the next
		// turn doesn't re-plan unless the user explicitly re-enables it.
		if (this.currentTurnUsedPlanMode) {
			this.currentTurnUsedPlanMode = false;
			this.planModeOn = false;
			this.composer.refreshPlanModeBtn();
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

