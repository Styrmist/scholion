import { SessionUsage } from "../types";
import { formatUsage } from "../utils/format";

export type StatusKind = "idle" | "thinking" | "tool" | "permission" | "error";

export interface StatusOptions {
	kind: StatusKind;
	label?: string;
}

export class StatusPill {
	private el: HTMLElement;
	private currentKind: StatusKind = "idle";
	private usage: SessionUsage | null = null;

	constructor(container: HTMLElement) {
		this.el = container.createDiv({ cls: "cc-status" });
		this.set({ kind: "idle" });
	}

	set(opts: StatusOptions): void {
		this.currentKind = opts.kind;
		this.el.removeClass(
			"cc-status--idle",
			"cc-status--thinking",
			"cc-status--tool",
			"cc-status--permission",
			"cc-status--error"
		);
		this.el.addClass(`cc-status--${opts.kind}`);
		const text = opts.label ?? defaultLabel(opts.kind, this.usage);
		this.el.setText(text);
	}

	setUsage(usage: SessionUsage | null): void {
		this.usage = usage;
		if (this.currentKind === "idle") {
			this.set({ kind: "idle" });
		}
	}
}

function defaultLabel(kind: StatusKind, usage: SessionUsage | null): string {
	switch (kind) {
		case "idle": return usage ? formatUsage(usage) : "Idle";
		case "thinking": return "Thinking…";
		case "tool": return "Running tool…";
		case "permission": return "Awaiting permission";
		case "error": return "Error";
	}
}

