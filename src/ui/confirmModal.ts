import { App, Modal } from "obsidian";

export function confirm(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.contentEl.createEl("p", { text: message });
		const actions = modal.contentEl.createDiv({ cls: "cc-modal__actions" });
		let resolved = false;
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			resolved = true;
			modal.close();
			resolve(false);
		});
		const okBtn = actions.createEl("button", { text: "Confirm", cls: "mod-warning" });
		okBtn.addEventListener("click", () => {
			resolved = true;
			modal.close();
			resolve(true);
		});
		modal.onClose = () => {
			if (!resolved) resolve(false);
		};
		modal.open();
	});
}

export function prompt(app: App, message: string, initial: string): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.contentEl.createEl("p", { text: message });
		const input = modal.contentEl.createEl("input", { type: "text", cls: "cc-modal__input" });
		input.value = initial;
		const actions = modal.contentEl.createDiv({ cls: "cc-modal__actions" });
		let resolved = false;
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			resolved = true;
			modal.close();
			resolve(null);
		});
		const okBtn = actions.createEl("button", { text: "Save", cls: "mod-cta" });
		const submit = () => {
			resolved = true;
			modal.close();
			resolve(input.value);
		};
		okBtn.addEventListener("click", submit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		modal.onClose = () => {
			if (!resolved) resolve(null);
		};
		modal.open();
		setTimeout(() => input.focus(), 0);
	});
}
