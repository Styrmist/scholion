import { Component } from "obsidian";
import type ClaudeCodePlugin from "../main";
import type { SessionRecord } from "../session/store";
import type { ToolIndex } from "../session/toolIndex";
import { ChatTurn, PermissionDecision, StreamEvent, ToolStatus } from "../types";
import { formatBytes } from "../utils/format";
import { MarkdownStream } from "./markdownStream";
import { ToolCard } from "./toolCard";

export interface TranscriptCallbacks {
	onPermissionRequested: (toolUseId: string, decision: PermissionDecision) => void;
	/**
	 * User clicked "Fork from here" on the assistant turn at this index in the
	 * current record. Index counts every entry in `record.turns` (user +
	 * assistant alike); the parent's turns up to and including this index
	 * become the inherited prefix of the new session.
	 */
	onForkFromTurn: (turnIndex: number) => void;
}

interface AssistantTurnContext {
	turn: ChatTurn;
	turnIndex: number;
	containerEl: HTMLElement;
	currentBubble: TextBubble | null;
	/** The fork button rendered on this turn (hidden until the turn finalizes). */
	forkBtn: HTMLElement | null;
}

interface TextBubble {
	messageId: string;
	stream: MarkdownStream;
	wrapperEl: HTMLElement;
}

export class TranscriptView {
	private container: HTMLElement;
	/** All tool cards across the entire transcript, indexed by tool_use_id. */
	private toolCards = new Map<string, ToolCard>();
	private active: AssistantTurnContext | null = null;
	private recordRef: (() => SessionRecord | null) | null = null;

	constructor(
		private plugin: ClaudeCodePlugin,
		private parent: Component,
		container: HTMLElement,
		private toolIndex: ToolIndex,
		private callbacks: TranscriptCallbacks
	) {
		this.container = container;
	}

	clear(): void {
		this.container.empty();
		this.toolCards.clear();
		this.toolIndex.clear();
		this.active = null;
	}

	/** Provide a getter for the active SessionRecord so block lookups can resolve across turns. */
	bindRecordRef(ref: (() => SessionRecord | null) | null): void {
		this.recordRef = ref;
	}

	scrollToBottom(): void {
		this.container.scrollTop = this.container.scrollHeight;
	}

	appendUserTurn(turn: ChatTurn): void {
		const turnEl = this.container.createDiv({ cls: ["cc-turn", "cc-turn--user"] });
		for (const block of turn.blocks) {
			if (block.type === "text") {
				const wrapper = turnEl.createDiv({ cls: "cc-turn__text" });
				const stream = new MarkdownStream(this.plugin, this.parent, wrapper);
				stream.set(block.markdown);
				void stream.finalize();
			} else if (block.type === "context_attachment") {
				const chip = turnEl.createDiv({ cls: "cc-attach-chip" });
				chip.setText(`[${block.kind}] ${block.path} (${formatBytes(block.bytes)})`);
			}
		}
		this.scrollToBottom();
	}

	appendSystemNotice(message: string): void {
		const el = this.container.createDiv({ cls: "cc-turn cc-turn--system" });
		el.setText(message);
		this.scrollToBottom();
	}

	/**
	 * Render an interactive notice with one or two action buttons. Used for
	 * the cycle-cap pause prompt; resolves itself to plain text once the user
	 * picks an option so the historical transcript stays readable.
	 */
	appendInteractiveNotice(args: {
		message: string;
		actions: Array<{ label: string; cls?: string; onClick: () => void }>;
	}): void {
		const el = this.container.createDiv({ cls: "cc-turn cc-turn--system cc-turn--interactive" });
		el.createDiv({ cls: "cc-turn__text", text: args.message });
		const actions = el.createDiv({ cls: "cc-perm-actions" });
		for (const action of args.actions) {
			const btn = actions.createEl("button", { text: action.label, cls: "cc-perm__btn" });
			if (action.cls) btn.addClass(action.cls);
			btn.addEventListener("click", () => {
				// Replace the buttons with a frozen "(picked: X)" line so the
				// notice still tells the story when the user scrolls back later.
				actions.empty();
				el.createDiv({ cls: "cc-turn__text cc-turn__text--muted", text: `→ ${action.label}` });
				action.onClick();
			});
		}
		this.scrollToBottom();
	}

	beginAssistantTurn(turn: ChatTurn, turnIndex: number): void {
		const turnEl = this.container.createDiv({ cls: ["cc-turn", "cc-turn--assistant"] });
		const forkBtn = this.makeForkButton(turnIndex);
		// Hide while streaming: forking an in-flight turn is undefined behavior
		// (the CLI subprocess is still running; the parent session would race
		// with the just-cloned fork). Reveal in finalizeTurn.
		forkBtn.addClass("cc-hidden");
		turnEl.appendChild(forkBtn);
		this.active = { turn, turnIndex, containerEl: turnEl, currentBubble: null, forkBtn };
		this.scrollToBottom();
	}

	private makeForkButton(turnIndex: number): HTMLElement {
		const btn = document.createElement("div");
		btn.addClass("cc-turn__fork-btn");
		btn.setText("Fork from here");
		btn.setAttribute("title", "Start a new chat that branches off after this reply.");
		btn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.callbacks.onForkFromTurn(turnIndex);
		});
		return btn;
	}

	handleEvent(event: StreamEvent): void {
		switch (event.kind) {
			case "assistant_text_delta":
				this.appendDelta(event.delta, event.messageId);
				break;
			case "assistant_text":
				this.setAssistantText(event.text, event.messageId);
				break;
			case "tool_use":
				this.appendToolUse(event.id, event.name, event.input);
				break;
			case "tool_result":
				this.applyToolResult(event.toolUseId, event.content, event.isError);
				break;
			default:
				break;
		}
	}

	private getOrCreateBubble(messageId: string): TextBubble | null {
		if (!this.active) return null;
		const current = this.active.currentBubble;
		if (current && (current.messageId === messageId || !messageId || !current.messageId)) {
			if (messageId) current.messageId = messageId;
			return current;
		}
		const wrapperEl = this.active.containerEl.createDiv({ cls: "cc-turn__text" });
		const bubble: TextBubble = {
			messageId,
			stream: new MarkdownStream(this.plugin, this.parent, wrapperEl),
			wrapperEl,
		};
		this.active.currentBubble = bubble;
		return bubble;
	}

	private appendDelta(delta: string, messageId: string): void {
		const bubble = this.getOrCreateBubble(messageId);
		if (!bubble) return;
		bubble.stream.append(delta);
		this.appendBlockToCurrentTurn(delta, bubble.messageId);
	}

	private setAssistantText(text: string, messageId: string): void {
		const bubble = this.getOrCreateBubble(messageId);
		if (!bubble) return;
		bubble.stream.set(text);
		this.replaceTextBlockForMessage(text, bubble.messageId);
	}

	private appendToolUse(toolUseId: string, tool: string, input: unknown): void {
		if (!this.active) {
			console.warn("[claude-code] appendToolUse with no active turn", { toolUseId, tool });
			return;
		}
		// New tool starts a new bubble for any subsequent text.
		this.active.currentBubble = null;
		const card = new ToolCard(this.active.containerEl, {
			app: this.plugin.app,
			toolUseId,
			tool,
			input,
			status: "running",
		});
		this.toolCards.set(toolUseId, card);
		const blocks = this.active.turn.blocks;
		blocks.push({
			type: "tool",
			toolUseId,
			tool,
			input,
			status: "running",
		});
		this.toolIndex.register(toolUseId, {
			turnIndex: this.active.turnIndex,
			blockIndex: blocks.length - 1,
		});
		this.scrollToBottom();
	}

	private applyToolResult(toolUseId: string, content: string, isError: boolean): void {
		let card = this.toolCards.get(toolUseId);
		const record = this.recordRef?.();
		if (!card && record && this.active) {
			// Defensive: a tool_result arriving for an id without a card means
			// the tool_use event somehow didn't create one. If the block does
			// exist in the record (so appendToolUse ran), lazily render the
			// card now so the user sees the result.
			const block = this.toolIndex.resolve(record, toolUseId);
			if (block) {
				console.warn("[claude-code] late tool_result without card, recovering", { toolUseId, tool: block.tool });
				card = new ToolCard(this.active.containerEl, {
					app: this.plugin.app,
					toolUseId: block.toolUseId,
					tool: block.tool,
					input: block.input,
					status: "running",
				});
				this.toolCards.set(toolUseId, card);
			}
		}
		if (card) {
			card.setOutput(content, isError);
			card.setStatus(isError ? "error" : "ok");
		}
		if (record) {
			this.toolIndex.applyResult(record, toolUseId, content, isError);
		}
	}

	requestPermissionFor(toolUseId: string, batchedToolUseIds: string[] = []): void {
		const card = this.toolCards.get(toolUseId);
		if (!card) return;
		const record = this.recordRef?.();
		const batchedInputs: unknown[] = [];
		if (record) {
			for (const id of batchedToolUseIds) {
				const block = this.toolIndex.resolve(record, id);
				if (block) batchedInputs.push(block.input);
				const sibling = this.toolCards.get(id);
				// Surface the pending state on sibling cards so the user can see
				// they're covered by the primary's prompt; no per-sibling buttons.
				sibling?.setStatus("pending_permission");
			}
		}
		card.requestPermission((decision) => {
			for (const id of batchedToolUseIds) {
				const sibling = this.toolCards.get(id);
				sibling?.setStatus(decision === "deny" ? "denied" : "running");
			}
			this.callbacks.onPermissionRequested(toolUseId, decision);
		}, batchedInputs);
	}

	removeToolCard(toolUseId: string): void {
		const card = this.toolCards.get(toolUseId);
		if (!card) return;
		card.el.remove();
		this.toolCards.delete(toolUseId);
	}

	setToolCardStatus(toolUseId: string, status: ToolStatus): void {
		const card = this.toolCards.get(toolUseId);
		card?.setStatus(status);
	}

	markAborted(): void {
		if (!this.active) return;
		this.active.turn.aborted = true;
		for (const block of this.active.turn.blocks) {
			if (block.type === "tool" && (block.status === "running" || block.status === "pending_permission")) {
				block.status = "aborted";
				const card = this.toolCards.get(block.toolUseId);
				card?.setStatus("aborted");
			}
		}
		this.active.containerEl.addClass("cc-turn--aborted");
	}

	finalizeTurn(): void {
		const bubble = this.active?.currentBubble;
		bubble?.stream.finalize().catch(() => undefined);
		// Reveal the fork affordance once the turn is no longer in flight.
		// Aborted turns also become forkable — branching off a partial reply
		// is sometimes exactly what the user wants.
		this.active?.forkBtn?.removeClass("cc-hidden");
		this.active = null;
	}

	private appendBlockToCurrentTurn(delta: string, messageId: string): void {
		if (!this.active) return;
		const blocks = this.active.turn.blocks;
		const last = blocks[blocks.length - 1];
		if (last && last.type === "text") {
			// Partial-message stream events don't carry messageId, so deltas land
			// with messageId="". When the real id arrives later, claim the running
			// text block instead of starting a duplicate.
			const sameId = last.messageId === messageId;
			const promotable = !last.messageId && Boolean(messageId);
			const continuing = !messageId;
			if (sameId || promotable || continuing) {
				if (promotable) last.messageId = messageId;
				last.markdown += delta;
				return;
			}
		}
		blocks.push({ type: "text", markdown: delta, messageId });
	}

	private replaceTextBlockForMessage(text: string, messageId: string): void {
		if (!this.active) return;
		const blocks = this.active.turn.blocks;
		// Walk backward but stop at the first non-text block — that bounds the
		// current text run. Inside it, accept either the matching messageId or
		// a placeholder block with an empty messageId (from partial streaming).
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i];
			if (!block) continue;
			if (block.type !== "text") break;
			if (block.messageId === messageId || !block.messageId) {
				block.markdown = text;
				block.messageId = messageId;
				return;
			}
		}
		blocks.push({ type: "text", markdown: text, messageId });
	}

	renderHistoricalTurns(turns: ChatTurn[]): void {
		this.clear();
		for (let i = 0; i < turns.length; i++) {
			const turn = turns[i]!;
			if (turn.role === "user") {
				this.appendUserTurn(turn);
				continue;
			}
			if (turn.role === "assistant") {
				const turnEl = this.container.createDiv({ cls: ["cc-turn", "cc-turn--assistant"] });
				if (turn.aborted) turnEl.addClass("cc-turn--aborted");
				for (const block of turn.blocks) {
					if (block.type === "text") {
						const wrapper = turnEl.createDiv({ cls: "cc-turn__text" });
						const stream = new MarkdownStream(this.plugin, this.parent, wrapper);
						stream.set(block.markdown);
						void stream.finalize();
					} else if (block.type === "tool") {
						const card = new ToolCard(turnEl, {
							app: this.plugin.app,
							toolUseId: block.toolUseId,
							tool: block.tool,
							input: block.input,
							status: block.status,
						});
						if (block.output !== undefined) {
							card.setOutput(block.output, block.isError ?? false);
						}
						this.toolCards.set(block.toolUseId, card);
					}
				}
				turnEl.appendChild(this.makeForkButton(i));
				continue;
			}
			this.appendSystemNotice(
				turn.blocks.map((b) => (b.type === "text" ? b.markdown : "")).join(" ")
			);
		}
		this.scrollToBottom();
	}
}

