import { PermissionDecision } from "../types";

export interface PermissionPromptArgs {
	tool: string;
	input: unknown;
	/**
	 * Inputs of additional same-tool calls batched into this prompt; the user's
	 * single decision will apply to all of them. Empty when not a batch.
	 */
	batchedInputs?: unknown[];
	onDecide: (decision: PermissionDecision) => void;
}

export function renderPermissionPrompt(container: HTMLElement, args: PermissionPromptArgs): void {
	container.empty();
	container.addClass("cc-perm");
	const batched = args.batchedInputs ?? [];
	const total = 1 + batched.length;
	const titleText = total === 1
		? `Allow Claude to use ${args.tool}?`
		: `Allow Claude to use ${args.tool} on ${total} calls?`;
	container.createDiv({ cls: "cc-perm__title", text: titleText });

	if (total === 1) {
		const inputPreview = container.createEl("pre", { cls: "cc-perm__input" });
		inputPreview.setText(formatInput(args.input));
	} else {
		const list = container.createDiv({ cls: "cc-perm__batch" });
		const allInputs = [args.input, ...batched];
		for (const inp of allInputs) {
			const row = list.createEl("pre", { cls: "cc-perm__input" });
			row.setText(formatInput(inp));
		}
		container.createDiv({
			cls: "cc-perm__batch-note",
			text: "Your decision applies to all of the above.",
		});
	}

	const actions = container.createDiv({ cls: "cc-perm-actions" });
	const onceLabel = total === 1 ? "Allow once" : "Allow all once";
	addButton(actions, onceLabel, () => args.onDecide("allowOnce"));
	addButton(actions, "Allow this session", () => args.onDecide("allowSession"));
	addButton(actions, "Allow always", () => args.onDecide("allowAlways"));
	const denyLabel = total === 1 ? "Deny" : "Deny all";
	addButton(actions, denyLabel, () => args.onDecide("deny"), "cc-perm__btn--danger");
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
