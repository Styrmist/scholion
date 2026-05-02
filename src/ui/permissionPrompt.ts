import { PermissionDecision } from "../types";

export interface PermissionPromptArgs {
	tool: string;
	input: unknown;
	onDecide: (decision: PermissionDecision) => void;
}

export function renderPermissionPrompt(container: HTMLElement, args: PermissionPromptArgs): void {
	container.empty();
	container.addClass("cc-perm");
	container.createDiv({ cls: "cc-perm__title", text: `Allow Claude to use ${args.tool}?` });
	const inputPreview = container.createEl("pre", { cls: "cc-perm__input" });
	inputPreview.setText(formatInput(args.input));

	const actions = container.createDiv({ cls: "cc-perm-actions" });
	addButton(actions, "Allow once", () => args.onDecide("once"));
	addButton(actions, "Allow this session", () => args.onDecide("session"));
	addButton(actions, "Allow always", () => args.onDecide("global"));
	addButton(actions, "Deny", () => args.onDecide("deny"), "cc-perm__btn--danger");
}

function addButton(parent: HTMLElement, label: string, onClick: () => void, extraClass?: string): void {
	const btn = parent.createEl("button", { text: label, cls: "cc-perm__btn" });
	if (extraClass) btn.addClass(extraClass);
	btn.addEventListener("click", () => onClick());
}

function formatInput(input: unknown): string {
	try {
		const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
		if (text.length > 800) return text.slice(0, 800) + "\n…";
		return text;
	} catch {
		return String(input);
	}
}
