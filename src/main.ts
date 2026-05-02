import { promises as fsp } from "fs";
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { BinaryInstaller } from "./binary/installer";
import { resolvePaths } from "./binary/paths";
import { AuthManager } from "./cli/auth";
import { ClaudeRunner } from "./cli/runner";
import { RIBBON_ICON, VIEW_TYPE_CHAT } from "./constants";
import { SessionStore } from "./session/store";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings";
import { ChatView } from "./ui/view";
import { ClaudeSettingsTab } from "./ui/settingsTab";
import { ensureDir } from "./utils/fs";
import { setVerbose } from "./utils/log";

export default class ClaudeCodePlugin extends Plugin {
	settings!: PluginSettings;
	installer!: BinaryInstaller;
	runner!: ClaudeRunner;
	sessions!: SessionStore;
	auth!: AuthManager;

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.installer = new BinaryInstaller(this);
		this.runner = new ClaudeRunner(this);
		this.sessions = new SessionStore(this);
		this.auth = new AuthManager(this);

		this.ensurePluginDirs();

		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon(RIBBON_ICON, "Claude Code", () => { void this.activateView(); });

		this.addCommand({
			id: "open",
			name: "Open chat",
			callback: () => { void this.activateView(); },
		});
		this.addCommand({
			id: "new-chat",
			name: "New chat",
			callback: () => { void this.activateView({ fresh: true }); },
		});

		this.addSettingTab(new ClaudeSettingsTab(this.app, this));

		if (this.settings.checkUpdatesOnStartup) {
			void this.installer.checkForUpdate().then((res) => {
				if (res.updateAvailable && res.current) {
					new Notice(`Claude Code update available: ${res.current} → ${res.latest}`);
				}
			}).catch(() => undefined);
		}
	}

	onunload(): void {
		this.runner.killAll();
		this.sessions.flushAllSync();
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
		this.settings.allowedTools = stored?.allowedTools ? [...stored.allowedTools] : [...DEFAULT_SETTINGS.allowedTools];
		this.settings.disallowedTools = stored?.disallowedTools ? [...stored.disallowedTools] : [];
		this.settings.sessions = stored?.sessions ? [...stored.sessions] : [];
		setVerbose(this.settings.verboseLogging);
	}

	async saveSettings(): Promise<void> {
		setVerbose(this.settings.verboseLogging);
		await this.saveData(this.settings);
	}

	async activateView(opts: { fresh?: boolean } = {}): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		let leaf: WorkspaceLeaf | null = existing.find((l) => l.getRoot() === workspace.rightSplit) ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice("Could not open Claude Code sidebar.");
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		}
		await workspace.revealLeaf(leaf);
		if (opts.fresh && leaf.view instanceof ChatView) {
			void leaf.view.startNewChat();
		}
	}

	async resetAllData(): Promise<void> {
		const paths = resolvePaths(this);
		await this.installer.resetInstall();
		try {
			await fsp.rm(paths.configDir, { recursive: true, force: true });
			await fsp.rm(paths.sessionsDir, { recursive: true, force: true });
		} catch { /* ignore */ }
		this.settings.sessions = [];
		await this.saveSettings();
		this.ensurePluginDirs();
	}

	private ensurePluginDirs(): void {
		try {
			const paths = resolvePaths(this);
			ensureDir(paths.binDir);
			ensureDir(paths.configDir);
			ensureDir(paths.sessionsDir);
			ensureDir(paths.tmpDir);
		} catch (e) {
			console.error("[claude-code] could not create plugin dirs", e);
		}
	}
}
