import type { MentionCandidate } from "../composer/mentions";

export interface MentionPopupOptions {
	onPick: (candidate: MentionCandidate) => void;
}

/**
 * Floating dropdown for `@`-mention autocomplete. Anchored above the composer
 * textarea (sidebar-friendly: anchoring at the cursor would require caret
 * geometry plumbing that isn't worth the complexity for a narrow leaf).
 *
 * Owned by Composer. Composer drives selection via `setItems` + `move` /
 * `pick`; the popup itself stays UI-only and renders whatever items it's
 * told to render.
 */
export class MentionPopup {
	readonly el: HTMLElement;
	private items: MentionCandidate[] = [];
	private selectedIndex = 0;
	private visible = false;

	constructor(parent: HTMLElement, private opts: MentionPopupOptions) {
		this.el = parent.createDiv({ cls: ["cc-mention-popup", "cc-hidden"] });
	}

	isVisible(): boolean {
		return this.visible;
	}

	setItems(items: MentionCandidate[]): void {
		this.items = items;
		// Clamp selection so it always lands on a valid row even after the
		// candidate list shrinks (e.g. user typed another character).
		if (this.selectedIndex >= items.length) {
			this.selectedIndex = Math.max(0, items.length - 1);
		}
		this.render();
	}

	show(): void {
		if (this.items.length === 0) {
			this.hide();
			return;
		}
		this.visible = true;
		this.el.removeClass("cc-hidden");
		this.render();
	}

	hide(): void {
		this.visible = false;
		this.el.addClass("cc-hidden");
		this.selectedIndex = 0;
	}

	move(direction: 1 | -1): void {
		if (!this.visible || this.items.length === 0) return;
		const len = this.items.length;
		this.selectedIndex = (this.selectedIndex + direction + len) % len;
		this.render();
	}

	/** Confirm the current selection. Returns true if a pick fired. */
	pick(): boolean {
		if (!this.visible || this.items.length === 0) return false;
		const item = this.items[this.selectedIndex];
		if (!item) return false;
		this.opts.onPick(item);
		return true;
	}

	private render(): void {
		this.el.empty();
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const row = this.el.createDiv({
				cls: i === this.selectedIndex
					? ["cc-mention-popup__row", "cc-mention-popup__row--selected"]
					: ["cc-mention-popup__row"],
			});
			row.createSpan({ cls: "cc-mention-popup__name", text: item.basename });
			if (item.path !== `${item.basename}.md`) {
				row.createSpan({ cls: "cc-mention-popup__path", text: item.path });
			}
			row.addEventListener("mousedown", (ev) => {
				// mousedown (not click) fires before the textarea blurs, so the
				// caret position is still valid when the picker callback splices.
				ev.preventDefault();
				this.selectedIndex = i;
				this.opts.onPick(item);
			});
		}
	}
}
