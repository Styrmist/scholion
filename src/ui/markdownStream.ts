import { Component, MarkdownRenderer } from "obsidian";
import type ClaudeCodePlugin from "../main";
import { STREAM_RENDER_DEBOUNCE_MS } from "../constants";
import { debounce } from "../utils/debounce";

/**
 * Streaming markdown renderer that "commits" finalized paragraphs to permanent
 * sub-elements as they fall behind a `\n\n` boundary outside any fenced code
 * block. Only the trailing live tail is re-parsed on each tick, so render cost
 * scales with the size of the in-flight paragraph rather than the whole buffer.
 */
export class MarkdownStream {
	private container: HTMLElement;
	private liveEl: HTMLElement;
	private buffer = "";
	private committedLen = 0;
	private fenceCountAtCommit = 0;
	private lastLiveRender = "";
	private flush: () => void;

	constructor(
		private plugin: ClaudeCodePlugin,
		private parent: Component,
		container: HTMLElement
	) {
		this.container = container;
		this.liveEl = container.createDiv({ cls: "cc-mdstream__live" });
		this.flush = debounce(() => void this.renderLive(), STREAM_RENDER_DEBOUNCE_MS);
	}

	append(delta: string): void {
		this.buffer += delta;
		this.tryCommit();
		this.flush();
	}

	set(markdown: string): void {
		this.buffer = markdown;
		this.committedLen = 0;
		this.fenceCountAtCommit = 0;
		this.lastLiveRender = "";
		this.container.empty();
		this.liveEl = this.container.createDiv({ cls: "cc-mdstream__live" });
		this.tryCommit();
		this.flush();
	}

	async finalize(): Promise<void> {
		// Commit any uncommitted tail as a final block, then clear the live element.
		if (this.committedLen < this.buffer.length) {
			const text = this.buffer.slice(this.committedLen);
			await this.commitBlock(text);
			this.committedLen = this.buffer.length;
		}
		this.liveEl.empty();
		this.lastLiveRender = "";
	}

	/**
	 * Look for the last `\n\n` in the uncommitted tail that sits outside any
	 * fenced code block. If found, render everything up to and including it as
	 * a frozen committed block.
	 */
	private tryCommit(): void {
		const tail = this.buffer.slice(this.committedLen);
		let fenceCount = this.fenceCountAtCommit;
		let lastSafeIdx = -1;
		let i = 0;
		while (i < tail.length) {
			if (tail[i] === "`" && tail[i + 1] === "`" && tail[i + 2] === "`") {
				fenceCount++;
				i += 3;
				continue;
			}
			if (tail[i] === "\n" && tail[i + 1] === "\n" && fenceCount % 2 === 0) {
				lastSafeIdx = i;
				i += 2;
				continue;
			}
			i++;
		}
		if (lastSafeIdx < 0) return;

		const cut = lastSafeIdx + 2; // include the trailing \n\n
		const text = tail.slice(0, cut);
		void this.commitBlock(text);
		this.committedLen += cut;
		this.fenceCountAtCommit = countFences(this.buffer.slice(0, this.committedLen));
		// Clear the live element so the just-committed text doesn't briefly duplicate.
		this.liveEl.empty();
		this.lastLiveRender = "";
	}

	private async commitBlock(text: string): Promise<void> {
		const block = this.container.createDiv({ cls: "cc-mdstream__block" });
		// container.createDiv appends to the end; move it above liveEl.
		this.container.insertBefore(block, this.liveEl);
		await MarkdownRenderer.render(
			this.plugin.app,
			text,
			block,
			this.plugin.app.vault.getRoot().path,
			this.parent
		);
	}

	private async renderLive(): Promise<void> {
		const live = this.buffer.slice(this.committedLen);
		if (live === this.lastLiveRender) return;
		this.lastLiveRender = live;
		this.liveEl.empty();
		if (!live) return;
		await MarkdownRenderer.render(
			this.plugin.app,
			live,
			this.liveEl,
			this.plugin.app.vault.getRoot().path,
			this.parent
		);
	}
}

function countFences(s: string): number {
	let count = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "`" && s[i + 1] === "`" && s[i + 2] === "`") {
			count++;
			i += 3;
		} else {
			i++;
		}
	}
	return count;
}
