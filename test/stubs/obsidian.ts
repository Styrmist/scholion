// Minimal stand-in for the `obsidian` module so source files that import
// from it can load in a Node-only Vitest environment. Only the surface area
// we actually exercise in tests is modeled — anything else is a no-op class
// so `instanceof` checks and constructor calls don't throw.
//
// If a test needs a particular Obsidian behavior it must build its own
// fixture against the App/Plugin shape; we deliberately do not try to
// emulate the real platform here.

export class Notice {
	constructor(_message: string, _timeout?: number) {
		void _message;
		void _timeout;
	}
	hide(): void {}
	setMessage(_m: string): this {
		void _m;
		return this;
	}
}

export class Component {
	load(): void {}
	unload(): void {}
	addChild<T extends Component>(child: T): T {
		return child;
	}
	removeChild<T extends Component>(child: T): T {
		return child;
	}
	register(_cb: () => unknown): void {
		void _cb;
	}
	registerEvent(_e: unknown): void {
		void _e;
	}
}

export class Plugin extends Component {
	app: unknown;
	manifest: unknown;
	constructor(app?: unknown, manifest?: unknown) {
		super();
		this.app = app;
		this.manifest = manifest;
	}
	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}
	saveData(_d: unknown): Promise<void> {
		void _d;
		return Promise.resolve();
	}
	addCommand(_c: unknown): void {
		void _c;
	}
	addRibbonIcon(): unknown {
		return {};
	}
	addSettingTab(): void {}
	registerView(): void {}
}

export class TFile {
	path = "";
	extension = "";
	name = "";
}

export class TFolder {
	path = "";
}

export class MarkdownView extends Component {
	file: TFile | null = null;
	editor: {
		getSelection(): string;
		getCursor(side: "from" | "to"): { line: number; ch: number };
	} = {
		getSelection: () => "",
		getCursor: () => ({ line: 0, ch: 0 }),
	};
}

export class WorkspaceLeaf {
	view: unknown = null;
	getRoot(): unknown {
		return null;
	}
	setViewState(_s: unknown): Promise<void> {
		void _s;
		return Promise.resolve();
	}
}

export class FileSystemAdapter {
	getBasePath(): string {
		return "/tmp/test-vault";
	}
}

export class Scope {
	constructor(_parent?: Scope) {
		void _parent;
	}
	register(_mods: string[], _key: string, _cb: (e: KeyboardEvent) => boolean): void {
		void _mods;
		void _key;
		void _cb;
	}
}

export class Modal {
	app: unknown;
	contentEl: { createDiv(): unknown; createEl(): unknown; empty(): void } = {
		createDiv: () => ({}),
		createEl: () => ({}),
		empty: () => undefined,
	};
	titleEl = this.contentEl;
	constructor(app: unknown) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class SuggestModal<T> extends Modal {
	getSuggestions(_q: string): T[] | Promise<T[]> {
		void _q;
		return [];
	}
	renderSuggestion(_i: T, _el: HTMLElement): void {
		void _i;
		void _el;
	}
	onChooseSuggestion(_i: T, _e: MouseEvent | KeyboardEvent): void {
		void _i;
		void _e;
	}
}

export class PluginSettingTab {
	containerEl: unknown = {};
	plugin: unknown;
	constructor(_app: unknown, plugin: unknown) {
		this.plugin = plugin;
	}
	display(): void {}
	hide(): void {}
}

export class Setting {
	constructor(_container: unknown) {
		void _container;
	}
	setName(_n: string): this {
		void _n;
		return this;
	}
	setDesc(_d: string): this {
		void _d;
		return this;
	}
	addText(_cb: (t: unknown) => void): this {
		void _cb;
		return this;
	}
	addToggle(_cb: (t: unknown) => void): this {
		void _cb;
		return this;
	}
	addButton(_cb: (b: unknown) => void): this {
		void _cb;
		return this;
	}
	addDropdown(_cb: (d: unknown) => void): this {
		void _cb;
		return this;
	}
	addTextArea(_cb: (t: unknown) => void): this {
		void _cb;
		return this;
	}
}

export class ItemView extends Component {
	app: unknown;
	containerEl: unknown = {};
	constructor(_leaf: unknown) {
		super();
	}
	getViewType(): string {
		return "stub";
	}
	getDisplayText(): string {
		return "stub";
	}
	getIcon(): string {
		return "";
	}
}

export class Menu {
	addItem(_cb: (i: unknown) => void): this {
		void _cb;
		return this;
	}
	showAtMouseEvent(_e: MouseEvent): void {
		void _e;
	}
	showAtPosition(_p: { x: number; y: number }): void {
		void _p;
	}
}

export interface App {
	[k: string]: unknown;
}

export function setIcon(_el: unknown, _name: string): void {
	void _el;
	void _name;
}

export function normalizePath(p: string): string {
	return p;
}

export class MarkdownRenderer {
	static render(
		_app: unknown,
		_md: string,
		_el: unknown,
		_path: string,
		_component: unknown
	): Promise<void> {
		void _app;
		void _md;
		void _el;
		void _path;
		void _component;
		return Promise.resolve();
	}
}
