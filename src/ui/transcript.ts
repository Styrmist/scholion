import { Component } from "obsidian";
import type ClaudeCodePlugin from "../main";
import { ChatTurn, PermissionDecision, StreamEvent, ToolBlock } from "../types";
import { MarkdownStream } from "./markdownStream";
import { ToolCard } from "./toolCard";

export interface TranscriptCallbacks {
	onPermissionRequested: (toolUseId: string, decision: PermissionDecision) => void;
}

interface AssistantTurnContext {
	turn: ChatTurn;
	containerEl: HTMLElement;
	currentBubble: TextBubble | null;
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

	constructor(
		private plugin: ClaudeCodePlugin,
		private parent: Component,
		container: HTMLElement,
		private callbacks: TranscriptCallbacks
	) {
		this.container = container;
	}

	clear(): void {
		this.container.empty();
		this.toolCards.clear();
		this.active = null;
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

	beginAssistantTurn(turn: ChatTurn): void {
		const turnEl = this.container.createDiv({ cls: ["cc-turn", "cc-turn--assistant"] });
		this.active = { turn, containerEl: turnEl, currentBubble: null };
		this.scrollToBottom();
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
		if (!this.active) return;
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
		this.active.turn.blocks.push({
			type: "tool",
			toolUseId,
			tool,
			input,
			status: "running",
		});
		this.scrollToBottom();
	}

	private applyToolResult(toolUseId: string, content: string, isError: boolean): void {
		const card = this.toolCards.get(toolUseId);
		if (card) {
			card.setOutput(content, isError);
			card.setStatus(isError ? "error" : "ok");
		}
		// Find the block by id across all turns, not just the current one.
		const block = this.findToolBlockGlobal(toolUseId);
		if (block) {
			block.status = isError ? "error" : "ok";
			block.output = content;
			block.isError = isError;
		}
	}

	requestPermissionFor(toolUseId: string): void {
		const card = this.toolCards.get(toolUseId);
		if (!card) return;
		card.requestPermission((decision) => {
			this.callbacks.onPermissionRequested(toolUseId, decision);
		});
	}

	removeToolCard(toolUseId: string): void {
		const card = this.toolCards.get(toolUseId);
		if (!card) return;
		card.el.remove();
		this.toolCards.delete(toolUseId);
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
		this.active = null;
	}

	private appendBlockToCurrentTurn(delta: string, messageId: string): void {
		if (!this.active) return;
		const blocks = this.active.turn.blocks;
		const last = blocks[blocks.length - 1];
		if (last && last.type === "text" && last.messageId === messageId) {
			last.markdown += delta;
		} else {
			blocks.push({ type: "text", markdown: delta, messageId });
		}
	}

	private replaceTextBlockForMessage(text: string, messageId: string): void {
		if (!this.active) return;
		const blocks = this.active.turn.blocks;
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i];
			if (block && block.type === "text" && block.messageId === messageId) {
				block.markdown = text;
				return;
			}
		}
		blocks.push({ type: "text", markdown: text, messageId });
	}

	private findToolBlockGlobal(toolUseId: string): ToolBlock | null {
		// Walk from the current turn outward; tool_use_id is unique per claude session.
		if (this.active) {
			for (const b of this.active.turn.blocks) {
				if (b.type === "tool" && b.toolUseId === toolUseId) return b;
			}
		}
		return null;
	}

	renderHistoricalTurns(turns: ChatTurn[]): void {
		this.clear();
		for (const turn of turns) {
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
				continue;
			}
			this.appendSystemNotice(
				turn.blocks.map((b) => (b.type === "text" ? b.markdown : "")).join(" ")
			);
		}
		this.scrollToBottom();
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
