import type { SlashCommand } from "../composer/slashCommands";

export interface SlashPopupOptions {
	onPick: (command: SlashCommand) => void;
}

/**
 * Floating dropdown for slash-command autocomplete. Mirrors `MentionPopup`
 * in shape and lifecycle: Composer drives selection via `setItems` +
 * `move` / `pick`; the popup itself stays UI-only and renders whatever
 * items it's told to render.
 */
export class SlashPopup {
	readonly el: HTMLElement;
	private items: SlashCommand[] = [];
	private selectedIndex = 0;
	private visible = false;

	constructor(parent: HTMLElement, private opts: SlashPopupOptions) {
		this.el = parent.createDiv({ cls: ["cc-slash-popup", "cc-hidden"] });
	}

	isVisible(): boolean {
		return this.visible;
	}

	setItems(items: SlashCommand[]): void {
		this.items = items;
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
					? ["cc-slash-popup__row", "cc-slash-popup__row--selected"]
					: ["cc-slash-popup__row"],
			});
			const main = row.createDiv({ cls: "cc-slash-popup__main" });
			main.createSpan({ cls: "cc-slash-popup__name", text: `/${item.name}` });
			if (item.argumentHint) {
				main.createSpan({ cls: "cc-slash-popup__hint", text: ` ${item.argumentHint}` });
			}
			if (item.description) {
				row.createDiv({ cls: "cc-slash-popup__desc", text: item.description });
			}
			row.createSpan({
				cls: ["cc-slash-popup__source", `cc-slash-popup__source--${item.source}`],
				text: item.source,
			});
			row.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				this.selectedIndex = i;
				this.opts.onPick(item);
			});
		}
	}
}
