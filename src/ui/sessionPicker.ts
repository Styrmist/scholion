import { App, Menu, Notice, SuggestModal, setIcon } from "obsidian";
import { SessionMeta } from "../types";
import { confirm, prompt } from "./confirmModal";

export interface SessionPickerCallbacks {
	onNewChat: () => void;
	onSelect: (localId: string) => void;
	onRename: (localId: string, title: string) => void;
	onDelete: (localId: string) => void;
	onExport: (localId: string) => void;
}

const NEW_CHAT_ITEM: SessionMeta = {
	localId: "__new__",
	title: "+ New chat",
	createdAt: 0,
	updatedAt: Number.MAX_SAFE_INTEGER,
	cwd: "",
};

export class SessionPicker {
	readonly el: HTMLElement;
	private button: HTMLElement;
	private label: HTMLElement;
	private menuButton: HTMLElement;
	private listProvider: () => SessionMeta[];
	private activeLocalId: string | null = null;

	constructor(
		private app: App,
		parent: HTMLElement,
		listProvider: () => SessionMeta[],
		private callbacks: SessionPickerCallbacks
	) {
		this.listProvider = listProvider;
		this.el = parent.createDiv({ cls: "cc-picker" });
		this.button = this.el.createEl("button", { cls: ["cc-picker__btn", "clickable-icon"] });
		this.label = this.button.createSpan({ cls: "cc-picker__label", text: "New chat" });
		this.button.addEventListener("click", () => this.openSuggest());

		this.menuButton = this.el.createEl("button", { cls: ["cc-picker__menu", "clickable-icon"] });
		setIcon(this.menuButton, "more-horizontal");
		this.menuButton.setAttribute("aria-label", "Session actions");
		this.menuButton.addEventListener("click", (evt) => this.openMenu(evt));
	}

	setActive(meta: SessionMeta | null): void {
		this.activeLocalId = meta?.localId ?? null;
		this.label.setText(meta ? meta.title : "New chat");
	}

	private openSuggest(): void {
		const sessions = this.listProvider();
		const modal = new SessionSuggestModal(this.app, sessions, (item) => {
			if (item.localId === NEW_CHAT_ITEM.localId) {
				this.callbacks.onNewChat();
			} else {
				this.callbacks.onSelect(item.localId);
			}
		});
		modal.open();
	}

	private openMenu(evt: MouseEvent): void {
		evt.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("New chat").setIcon("plus").onClick(() => this.callbacks.onNewChat());
		});
		if (this.activeLocalId) {
			menu.addSeparator();
			menu.addItem((item) => {
				item.setTitle("Rename current…").setIcon("pencil").onClick(() => this.promptRename());
			});
			menu.addItem((item) => {
				item.setTitle("Export current to note…").setIcon("file-down").onClick(() => this.triggerExport());
			});
			menu.addItem((item) => {
				item.setTitle("Delete current…").setIcon("trash").onClick(() => this.promptDelete());
			});
		}
		menu.showAtMouseEvent(evt);
	}

	private promptRename(): void {
		if (!this.activeLocalId) {
			new Notice("Select a session first.");
			return;
		}
		const current = this.label.getText();
		const localId = this.activeLocalId;
		void prompt(this.app, "Rename chat", current).then((next) => {
			if (next && next.trim()) this.callbacks.onRename(localId, next.trim());
		});
	}

	private triggerExport(): void {
		if (!this.activeLocalId) return;
		this.callbacks.onExport(this.activeLocalId);
	}

	private promptDelete(): void {
		if (!this.activeLocalId) return;
		const localId = this.activeLocalId;
		void confirm(this.app, "Delete this chat? This cannot be undone.").then((ok) => {
			if (ok) this.callbacks.onDelete(localId);
		});
	}
}

class SessionSuggestModal extends SuggestModal<SessionMeta> {
	constructor(
		app: App,
		private sessions: SessionMeta[],
		private onChoose: (item: SessionMeta) => void
	) {
		super(app);
		this.setPlaceholder("Search chats…");
	}

	getSuggestions(query: string): SessionMeta[] {
		const q = query.toLowerCase().trim();
		const sorted = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
		const matches = q
			? sorted.filter((s) => s.title.toLowerCase().includes(q))
			: sorted;
		return [NEW_CHAT_ITEM, ...matches];
	}

	renderSuggestion(item: SessionMeta, el: HTMLElement): void {
		el.addClass("cc-picker__suggest");
		const main = el.createDiv({ cls: "cc-picker__suggest-main" });
		const titleRow = main.createDiv({ cls: "cc-picker__suggest-titlerow" });
		titleRow.createDiv({ cls: "cc-picker__suggest-title", text: item.title });
		if (item.localId !== NEW_CHAT_ITEM.localId) {
			titleRow.createDiv({ cls: "cc-picker__suggest-date", text: formatRelativeTime(item.updatedAt) });
		}
		if (item.lastTurnSummary) {
			main.createDiv({ cls: "cc-picker__suggest-summary", text: item.lastTurnSummary });
		}
	}

	onChooseSuggestion(item: SessionMeta): void {
		this.onChoose(item);
	}
}

function formatRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	const date = new Date(ts);
	const now = new Date();
	const sameYear = date.getFullYear() === now.getFullYear();
	const month = date.toLocaleString("en-US", { month: "short" });
	return sameYear ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}
