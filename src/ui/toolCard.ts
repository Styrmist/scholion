import { App } from "obsidian";
import { TOOL_OUTPUT_PREVIEW_BYTES } from "../constants";
import { PermissionDecision, ToolStatus } from "../types";
import { formatBytes } from "../utils/format";
import { showFullOutput } from "./fullOutputModal";
import { renderPermissionPrompt } from "./permissionPrompt";

export interface ToolCardOptions {
	app: App;
	toolUseId: string;
	tool: string;
	input: unknown;
	status: ToolStatus;
}

export class ToolCard {
	readonly toolUseId: string;
	readonly tool: string;
	readonly el: HTMLElement;
	private app: App;
	private headerEl: HTMLElement;
	private bodyEl: HTMLElement;
	private outputEl: HTMLElement | null = null;
	private viewFullBtn: HTMLElement | null = null;
	private permissionEl: HTMLElement | null = null;
	private input: unknown;
	private status: ToolStatus;
	private fullOutput: string | null = null;
	private fullIsError = false;

	constructor(parent: HTMLElement, opts: ToolCardOptions) {
		this.app = opts.app;
		this.toolUseId = opts.toolUseId;
		this.tool = opts.tool;
		this.input = opts.input;
		this.status = opts.status;
		this.el = parent.createDiv({ cls: ["cc-toolcard", `cc-toolcard--${opts.status}`] });
		this.headerEl = this.el.createDiv({ cls: "cc-toolcard__header" });
		this.bodyEl = this.el.createDiv({ cls: "cc-toolcard__body" });
		this.bodyEl.addClass("cc-hidden");
		this.headerEl.addEventListener("click", () => this.toggleBody());
		this.renderHeader();
		this.renderInput();
	}

	setStatus(status: ToolStatus): void {
		this.el.removeClass(
			"cc-toolcard--pending_permission",
			"cc-toolcard--running",
			"cc-toolcard--ok",
			"cc-toolcard--error",
			"cc-toolcard--denied",
			"cc-toolcard--aborted"
		);
		this.el.addClass(`cc-toolcard--${status}`);
		this.status = status;
		this.renderHeader();
	}

	setOutput(output: string, isError: boolean): void {
		if (!this.outputEl) {
			this.outputEl = this.bodyEl.createEl("pre", { cls: "cc-toolcard__output" });
		}
		const truncated = output.length > TOOL_OUTPUT_PREVIEW_BYTES
			? output.slice(0, TOOL_OUTPUT_PREVIEW_BYTES) + `\n… (${output.length - TOOL_OUTPUT_PREVIEW_BYTES} bytes truncated)`
			: output;
		this.outputEl.setText(truncated);
		this.outputEl.toggleClass("cc-toolcard__output--error", isError);
		this.fullOutput = output;
		this.fullIsError = isError;
		this.renderViewFullBtn();
	}

	private renderViewFullBtn(): void {
		if (!this.fullOutput || this.fullOutput.length <= TOOL_OUTPUT_PREVIEW_BYTES) {
			this.viewFullBtn?.remove();
			this.viewFullBtn = null;
			return;
		}
		if (!this.viewFullBtn) {
			this.viewFullBtn = this.bodyEl.createEl("button", { cls: "cc-toolcard__viewfull" });
			this.viewFullBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				if (!this.fullOutput) return;
				const summary = summarizeInput(this.input);
				const title = summary ? `${this.tool} — ${summary}` : this.tool;
				showFullOutput(this.app, title, this.fullOutput, this.fullIsError);
			});
		}
		this.viewFullBtn.setText(`View full output (${formatBytes(this.fullOutput.length)})`);
	}

	requestPermission(onDecide: (decision: PermissionDecision) => void): void {
		this.setStatus("pending_permission");
		if (!this.permissionEl) {
			this.permissionEl = this.bodyEl.createDiv();
		}
		renderPermissionPrompt(this.permissionEl, {
			tool: this.tool,
			input: this.input,
			onDecide: (decision) => {
				this.permissionEl?.remove();
				this.permissionEl = null;
				onDecide(decision);
			},
		});
		this.bodyEl.removeClass("cc-hidden");
	}

	private renderHeader(): void {
		this.headerEl.empty();
		this.headerEl.createSpan({ cls: "cc-toolcard__icon", text: this.statusIcon() });
		this.headerEl.createSpan({ cls: "cc-toolcard__name", text: this.tool });
		const summary = summarizeInput(this.input);
		if (summary) this.headerEl.createSpan({ cls: "cc-toolcard__summary", text: summary });
	}

	private renderInput(): void {
		const pre = this.bodyEl.createEl("pre", { cls: "cc-toolcard__input" });
		pre.setText(prettyJson(this.input));
	}

	private toggleBody(): void {
		this.bodyEl.toggleClass("cc-hidden", !this.bodyEl.hasClass("cc-hidden"));
	}

	private statusIcon(): string {
		switch (this.status) {
			case "pending_permission": return "❓";
			case "running": return "▶";
			case "ok": return "✓";
			case "error": return "✕";
			case "denied": return "⊘";
			case "aborted": return "⊘";
		}
	}
}

function summarizeInput(input: unknown): string {
	if (input && typeof input === "object") {
		const obj = input as Record<string, unknown>;
		const candidates = ["file_path", "path", "command", "pattern"];
		for (const key of candidates) {
			const v = obj[key];
			if (typeof v === "string") return truncateText(v, 80);
		}
	}
	if (typeof input === "string") return truncateText(input, 80);
	return "";
}

function truncateText(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

