import { DiagnosticEntry } from "../types";

export interface DiagnosticsPanelCallbacks {
	onClear: () => void;
}

export class DiagnosticsPanel {
	readonly el: HTMLDetailsElement;
	private summaryEl: HTMLElement;
	private listEl: HTMLOListElement;
	private clearBtn: HTMLButtonElement;
	private entries: DiagnosticEntry[] = [];
	private renderedOpen = false;

	constructor(parent: HTMLElement, private callbacks: DiagnosticsPanelCallbacks) {
		this.el = parent.createEl("details", { cls: "cc-diagnostics" });
		this.el.addClass("cc-hidden");
		this.summaryEl = this.el.createEl("summary", { cls: "cc-diagnostics__summary" });
		const label = this.summaryEl.createSpan({ cls: "cc-diagnostics__label" });
		label.setText("Diagnostics (0)");
		this.clearBtn = this.summaryEl.createEl("button", {
			cls: "cc-diagnostics__clear",
			text: "Clear",
		});
		this.clearBtn.type = "button";
		this.clearBtn.addEventListener("click", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.callbacks.onClear();
		});
		this.listEl = this.el.createEl("ol", { cls: "cc-diagnostics__list" });
		this.el.addEventListener("toggle", () => {
			if (this.el.open && !this.renderedOpen) this.renderList();
		});
	}

	setEntries(entries: DiagnosticEntry[] | undefined): void {
		this.entries = entries ?? [];
		this.updateSummary();
		this.renderedOpen = false;
		if (this.el.open) this.renderList();
	}

	append(entry: DiagnosticEntry): void {
		this.entries.push(entry);
		this.updateSummary();
		if (this.el.open) {
			this.appendOne(entry);
		} else {
			this.renderedOpen = false;
		}
	}

	private updateSummary(): void {
		const count = this.entries.length;
		const label = this.summaryEl.querySelector(".cc-diagnostics__label");
		if (label) label.setText(`Diagnostics (${count})`);
		this.el.toggleClass("cc-hidden", count === 0);
	}

	private renderList(): void {
		this.listEl.empty();
		for (const entry of this.entries) this.appendOne(entry);
		this.renderedOpen = true;
	}

	private appendOne(entry: DiagnosticEntry): void {
		const li = this.listEl.createEl("li", { cls: `cc-diagnostics__item cc-diagnostics__item--${entry.kind}` });
		li.createSpan({ cls: "cc-diagnostics__time", text: formatTime(entry.ts) });
		li.createSpan({ cls: "cc-diagnostics__kind", text: entry.kind });
		li.createSpan({ cls: "cc-diagnostics__text", text: entry.text });
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}
