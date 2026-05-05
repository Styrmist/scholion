import { App, Scope, setIcon } from "obsidian";
import { detectMentionQuery, MentionCandidate, rankMentionCandidates } from "../composer/mentions";
import { CapturedContext } from "../context/activeNote";
import { SendMethod } from "../types";
import { formatBytes } from "../utils/format";
import { MentionPopup } from "./mentionPopup";

export type AttachMode = "auto" | "none";

export interface ComposerSubmit {
	text: string;
	attachContext: boolean;
}

export interface ComposerCallbacks {
	onSubmit: (submit: ComposerSubmit) => void;
	onAbort: () => void;
	getSendMethod: () => SendMethod;
	/** All vault candidates available for autocomplete; ordered by recency. */
	getMentionCandidates: () => MentionCandidate[];
	/** True when the mentions feature is enabled in settings. */
	isMentionsEnabled: () => boolean;
}

const MENTION_POPUP_LIMIT = 8;

export class Composer {
	readonly el: HTMLElement;
	private textarea: HTMLTextAreaElement;
	private chipEl: HTMLElement;
	private sendBtn: HTMLButtonElement;
	private busy = false;
	private attachEnabled = true;
	private context: CapturedContext | null = null;
	private alreadyInContext = false;
	private modEnterScope: Scope | null = null;
	private mentionPopup: MentionPopup;
	/** Cursor index of the active `@` trigger, or null when no mention popup is in flight. */
	private activeMentionTriggerStart: number | null = null;

	constructor(parent: HTMLElement, private app: App, private callbacks: ComposerCallbacks) {
		this.el = parent.createDiv({ cls: "cc-composer" });
		this.chipEl = this.el.createDiv({ cls: ["cc-attach-chip", "cc-attach-chip--hidden"] });
		this.chipEl.addEventListener("click", () => {
			if (!this.context) return;
			this.attachEnabled = !this.attachEnabled;
			this.refreshChip();
		});

		// Popup must come before the textarea in DOM order so absolute
		// positioning can anchor it above without negative margins.
		this.mentionPopup = new MentionPopup(this.el, {
			onPick: (candidate) => this.applyMentionPick(candidate),
		});

		this.textarea = this.el.createEl("textarea", { cls: "cc-composer__input" });
		this.textarea.rows = 3;
		this.refreshPlaceholder();
		this.textarea.addEventListener("keydown", (e) => {
			// Mention popup capture: when visible, eat navigation/confirm keys
			// so the textarea doesn't move the caret instead.
			if (this.mentionPopup.isVisible()) {
				if (e.key === "ArrowDown") { e.preventDefault(); this.mentionPopup.move(1); return; }
				if (e.key === "ArrowUp")   { e.preventDefault(); this.mentionPopup.move(-1); return; }
				if (e.key === "Escape")    { e.preventDefault(); this.dismissMentionPopup(); return; }
				if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing && !e.shiftKey) {
					if (this.mentionPopup.pick()) { e.preventDefault(); return; }
				}
			}
			if (e.key !== "Enter" || e.isComposing) return;
			// Mod+Enter is handled by the Obsidian Scope below; Ctrl+Enter on macOS is intentionally ignored.
			if (e.metaKey || e.ctrlKey) return;
			const method = this.callbacks.getSendMethod();
			if (method === "enter") {
				if (e.shiftKey) return; // newline
				e.preventDefault();
				this.submit();
			}
			// "cmdEnter" mode: plain Enter inserts a newline (browser default).
		});
		this.textarea.addEventListener("input", () => this.refreshMentionPopup());
		this.textarea.addEventListener("click", () => this.refreshMentionPopup());
		this.textarea.addEventListener("keyup", (e) => {
			// Caret movement via arrows / home / end won't fire `input`; check those.
			if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
				this.refreshMentionPopup();
			}
		});
		this.textarea.addEventListener("focus", () => this.installModEnter());
		this.textarea.addEventListener("blur", () => {
			this.uninstallModEnter();
			// Defer dismissal so a click on the popup row (mousedown-handled) fires first.
			setTimeout(() => this.dismissMentionPopup(), 0);
		});
		if (document.activeElement === this.textarea) this.installModEnter();

		const actions = this.el.createDiv({ cls: "cc-composer__actions" });
		this.sendBtn = actions.createEl("button", { cls: ["cc-composer__send", "mod-cta"], text: "Send" });
		this.sendBtn.addEventListener("click", () => this.submit());

		const stop = actions.createEl("button", { cls: ["cc-composer__stop", "cc-hidden"], text: "Stop" });
		setIcon(stop, "square");
		stop.addEventListener("click", () => callbacks.onAbort());
		stop.dataset.role = "stop";
	}

	updateContext(context: CapturedContext | null, alreadyInContext: boolean): void {
		this.context = context;
		this.alreadyInContext = alreadyInContext;
		if (context && !this.attachEnabled) this.attachEnabled = true;
		this.refreshChip();
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		this.textarea.disabled = busy;
		this.sendBtn.disabled = busy;
		const stop = this.el.querySelector<HTMLButtonElement>('[data-role="stop"]');
		if (stop) stop.toggleClass("cc-hidden", !busy);
		this.sendBtn.toggleClass("cc-hidden", busy);
	}

	focus(): void {
		this.textarea.focus();
	}

	refreshPlaceholder(): void {
		const method = this.callbacks.getSendMethod();
		this.textarea.placeholder =
			method === "enter"
				? "Ask Claude…  (Enter to send, Shift+Enter for newline)"
				: "Ask Claude…  (⌘↵ to send, Enter for newline)";
	}

	dispose(): void {
		this.uninstallModEnter();
	}

	private installModEnter(): void {
		if (this.modEnterScope) return;
		this.modEnterScope = new Scope(this.app.scope);
		this.modEnterScope.register(["Mod"], "Enter", (e) => {
			if (this.busy) return false;
			e.preventDefault();
			this.submit();
			return false;
		});
		this.app.keymap.pushScope(this.modEnterScope);
	}

	private uninstallModEnter(): void {
		if (!this.modEnterScope) return;
		this.app.keymap.popScope(this.modEnterScope);
		this.modEnterScope = null;
	}

	private submit(): void {
		if (this.busy) return;
		const text = this.textarea.value.trim();
		if (!text) return;
		this.dismissMentionPopup();
		this.textarea.value = "";
		this.callbacks.onSubmit({ text, attachContext: this.attachEnabled });
	}

	private refreshMentionPopup(): void {
		if (!this.callbacks.isMentionsEnabled()) {
			this.dismissMentionPopup();
			return;
		}
		const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
		const before = this.textarea.value.slice(0, cursor);
		const detected = detectMentionQuery(before);
		if (!detected) {
			this.dismissMentionPopup();
			return;
		}
		const candidates = this.callbacks.getMentionCandidates();
		const ranked = rankMentionCandidates(candidates, detected.query, MENTION_POPUP_LIMIT);
		if (ranked.length === 0) {
			this.dismissMentionPopup();
			return;
		}
		this.activeMentionTriggerStart = detected.triggerStart;
		this.mentionPopup.setItems(ranked);
		this.mentionPopup.show();
	}

	private dismissMentionPopup(): void {
		this.activeMentionTriggerStart = null;
		this.mentionPopup.hide();
	}

	private applyMentionPick(candidate: MentionCandidate): void {
		const triggerStart = this.activeMentionTriggerStart;
		if (triggerStart === null) return;
		const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
		const before = this.textarea.value.slice(0, triggerStart);
		const after = this.textarea.value.slice(cursor);
		// Insertion uses basename — Obsidian's metadataCache resolves it the same
		// way it resolves any wikilink, including disambiguating duplicates.
		const insertion = `@[[${candidate.basename}]] `;
		this.textarea.value = before + insertion + after;
		const newCursor = before.length + insertion.length;
		this.textarea.setSelectionRange(newCursor, newCursor);
		this.textarea.focus();
		this.dismissMentionPopup();
	}

	private refreshChip(): void {
		if (!this.context) {
			this.chipEl.addClass("cc-attach-chip--hidden");
			return;
		}
		this.chipEl.removeClass("cc-attach-chip--hidden");
		const label = this.attachEnabled
			? (this.alreadyInContext
				? `[${this.context.kind}] ${this.context.path} — already in context`
				: `[${this.context.kind}] ${this.context.path} (${formatBytes(this.context.bytes)})`)
			: "(no context attached)";
		this.chipEl.empty();
		this.chipEl.createSpan({ text: label });
		this.chipEl.createSpan({
			cls: "cc-attach-chip__close",
			text: this.attachEnabled ? "×" : "+",
		});
	}
}

