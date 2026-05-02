import { App, Modal } from "obsidian";

export function showFullOutput(app: App, title: string, content: string, isError: boolean): void {
	const modal = new Modal(app);
	modal.titleEl.setText(title);
	const pre = modal.contentEl.createEl("pre", { cls: "cc-fulloutput" });
	if (isError) pre.addClass("cc-fulloutput--error");
	pre.setText(content);
	const actions = modal.contentEl.createDiv({ cls: "cc-modal__actions" });
	const copyBtn = actions.createEl("button", { text: "Copy" });
	copyBtn.addEventListener("click", () => {
		void navigator.clipboard.writeText(content);
		copyBtn.setText("Copied");
		setTimeout(() => copyBtn.setText("Copy"), 1000);
	});
	const closeBtn = actions.createEl("button", { text: "Close", cls: "mod-cta" });
	closeBtn.addEventListener("click", () => modal.close());
	modal.open();
}
