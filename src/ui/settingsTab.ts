import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCodePlugin from "../main";
import { resolvePaths } from "../binary/paths";
import { LoginPhase } from "../cli/auth";
import { VIEW_TYPE_CHAT } from "../constants";
import { SendMethod } from "../types";
import { getElectronShell } from "../utils/electron";
import { ChatView } from "./view";
import { confirm } from "./confirmModal";

const TOOL_OPTIONS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Task"] as const;

const MODEL_ALIASES: ReadonlyArray<{ value: string; label: string; desc: string }> = [
	{ value: "sonnet", label: "sonnet", desc: "Latest Sonnet, everyday notes and writing" },
	{ value: "opus", label: "opus", desc: "Latest Opus, complex reasoning" },
	{ value: "haiku", label: "haiku", desc: "Fast / efficient, simple tasks" },
	{ value: "opusplan", label: "opusplan", desc: "Opus while planning, Sonnet while executing" },
];
const CUSTOM_MODEL_VALUE = "__custom__";
const KNOWN_MODEL_VALUES = new Set(MODEL_ALIASES.map((m) => m.value));

export class ClaudeSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: ClaudeCodePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderAccountSection(containerEl);
		this.renderBinarySection(containerEl);
		this.renderSafetySection(containerEl);
		this.renderPermissionsSection(containerEl);
		this.renderModelSection(containerEl);
		this.renderContextSection(containerEl);
		this.renderComposerSection(containerEl);
		this.renderAdvancedSection(containerEl);
	}

	private renderAccountSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Account").setHeading();

		const status = new Setting(containerEl)
			.setName("Authentication")
			.setDesc("Loading…");

		this.plugin.auth.isAuthenticated().then((ok) => {
			const email = ok ? this.plugin.auth.getSignedInEmail() : null;
			status.setDesc(ok ? (email ? `Signed in as ${email}.` : "Signed in.") : "Not signed in.");
			status.controlEl.empty();
			if (ok) {
				const btn = status.controlEl.createEl("button", { text: "Sign out" });
				btn.addEventListener("click", () => {
					void (async () => {
						await this.plugin.auth.logout();
						new Notice("Signed out of Claude Code.");
						this.display();
					})();
				});
			} else {
				const btn = status.controlEl.createEl("button", { text: "Sign in", cls: "mod-cta" });
				btn.addEventListener("click", () => {
					new LoginModal(this.app, this.plugin, () => this.display()).open();
				});
			}
		}).catch((err: unknown) => {
			status.setDesc(`Auth check failed: ${(err as Error).message}`);
		});
	}

	private renderBinarySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Binary").setHeading();

		const versionRow = new Setting(containerEl)
			.setName("Claude Code version")
			.setDesc("Loading…");
		const refresh = () => {
			void this.plugin.installer.getInstalledVersion().then((current) => {
				versionRow.setDesc(current ? `Installed: ${current}` : "Not installed.");
			});
		};
		refresh();

		new Setting(containerEl)
			.setName("Install or update")
			.setDesc("Download the latest Claude Code into the plugin folder.")
			.addButton((b) =>
				b.setButtonText("Install latest").onClick(async () => {
					try {
						await this.plugin.installer.install({
							onProgress: ({ receivedBytes, totalBytes }) => {
								if (totalBytes) {
									const pct = Math.floor((receivedBytes / totalBytes) * 100);
									versionRow.setDesc(`Downloading… ${pct}%`);
								} else {
									versionRow.setDesc(`Downloading… ${(receivedBytes / 1024 / 1024).toFixed(1)} MB`);
								}
							},
						});
						refresh();
					} catch (e) {
						new Notice(`Install failed: ${(e as Error).message}`);
					}
				})
			)
			.addButton((b) =>
				b.setButtonText("Check for updates").onClick(async () => {
					try {
						const result = await this.plugin.installer.checkForUpdate();
						versionRow.setDesc(
							`Installed: ${result.current ?? "(none)"} — Latest: ${result.latest}` +
								(result.updateAvailable ? " (update available)" : "")
						);
					} catch (e) {
						new Notice(`Update check failed: ${(e as Error).message}`);
					}
				})
			);

		new Setting(containerEl)
			.setName("Check for updates on startup")
			.setDesc("Background-check on plugin load.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.checkUpdatesOnStartup).onChange(async (value) => {
					this.plugin.settings.checkUpdatesOnStartup = value;
					await this.plugin.saveSettings();
				})
			);
	}

	private renderSafetySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Working directory & safety").setHeading();
		new Setting(containerEl)
			.setName("Working directory")
			.setDesc("Vault root. Reads and writes outside the vault are not allowed.")
			.addText((t) => {
				t.setValue("Vault root").setDisabled(true);
			});
		const denyEl = containerEl.createEl("pre", { cls: "cc-settings__deny" });
		const cfg = this.app.vault.configDir;
		denyEl.setText(
			[
				"Always-on deny rules:",
				`  Read   ./${cfg}/**`,
				`  Edit   ./${cfg}/**`,
				`  Write  ./${cfg}/**`,
				`  Bash   commands matching *${cfg}*`,
			].join("\n")
		);
	}

	private renderPermissionsSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Permissions").setHeading();

		new Setting(containerEl)
			.setName("Default permission mode")
			.addDropdown((d) =>
				d
					.addOption("default", "Default (ask)")
					.addOption("acceptEdits", "Accept edits")
					.addOption("plan", "Plan only")
					.setValue(this.plugin.settings.permissionMode)
					.onChange((value) => {
						this.plugin.settings.permissionMode = value as typeof this.plugin.settings.permissionMode;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Always-allowed tools")
			.setDesc("Tools Claude can use without asking. Edit/Write/Bash are off by default.");
		const allowedEl = containerEl.createDiv({ cls: "cc-settings__tools" });
		this.renderToolToggles(allowedEl, "allowedTools");
		const bashWarning = containerEl.createDiv({ cls: "cc-settings__warning" });
		this.refreshBashWarning(bashWarning);

		new Setting(containerEl)
			.setName("Always-denied tools")
			.setDesc("Tools Claude can never use, regardless of session grants.");
		const deniedEl = containerEl.createDiv({ cls: "cc-settings__tools" });
		this.renderToolToggles(deniedEl, "disallowedTools");
	}

	private renderToolToggles(host: HTMLElement, key: "allowedTools" | "disallowedTools"): void {
		host.empty();
		for (const tool of TOOL_OPTIONS) {
			const wrap = host.createDiv({ cls: "cc-settings__tool" });
			const cb = wrap.createEl("input", { type: "checkbox" });
			cb.checked = this.plugin.settings[key].includes(tool);
			cb.addEventListener("change", () => {
				const list = new Set(this.plugin.settings[key]);
				if (cb.checked) list.add(tool); else list.delete(tool);
				this.plugin.settings[key] = Array.from(list);
				void this.plugin.saveSettings();
				if (key === "allowedTools") {
					const warningEl = host.parentElement?.querySelector<HTMLElement>(".cc-settings__warning");
					if (warningEl) this.refreshBashWarning(warningEl);
				}
			});
			wrap.createSpan({ text: ` ${tool}` });
		}
	}

	private refreshBashWarning(host: HTMLElement): void {
		host.empty();
		if (this.plugin.settings.allowedTools.includes("Bash")) {
			host.setText(
				"Warning: Bash is path-unconstrained. With Bash allowed, Claude can read or modify files outside your vault."
			);
		}
	}

	private renderModelSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Model & prompt").setHeading();

		const current = this.plugin.settings.model;
		const isKnown = KNOWN_MODEL_VALUES.has(current);
		const initialDropdown = isKnown ? current : CUSTOM_MODEL_VALUE;

		// Forward declarations so the dropdown handler can toggle the custom row.
		let customRowEl: HTMLElement | null = null;
		let customInput: HTMLInputElement | null = null;

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Pick a built-in alias or choose custom to enter a full model name.")
			.addDropdown((d) => {
				for (const alias of MODEL_ALIASES) {
					const label = alias.desc ? `${alias.label} — ${alias.desc}` : alias.label;
					d.addOption(alias.value, label);
				}
				d.addOption(CUSTOM_MODEL_VALUE, "Custom…");
				d.setValue(initialDropdown).onChange(async (value) => {
					if (value === CUSTOM_MODEL_VALUE) {
						customRowEl?.removeClass("cc-hidden");
						customInput?.focus();
					} else {
						customRowEl?.addClass("cc-hidden");
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					}
				});
			});

		const customRow = new Setting(containerEl)
			.setName("Custom model")
			.setDesc("Full model name (for example claude-opus-4-7), an inference profile arn, or a deployment name.")
			.addText((t) => {
				customInput = t.inputEl;
				t.setPlaceholder("Model name")
					.setValue(isKnown ? "" : current)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					});
			});
		customRowEl = customRow.settingEl;
		customRowEl.toggleClass("cc-hidden", isKnown);

		new Setting(containerEl)
			.setName("System prompt addendum")
			.setDesc("Appended on top of Claude Code's default system prompt.")
			.addTextArea((t) => {
				t.setValue(this.plugin.settings.systemPromptAddendum);
				t.inputEl.rows = 4;
				t.onChange(async (value) => {
					this.plugin.settings.systemPromptAddendum = value;
					await this.plugin.saveSettings();
				});
			});
	}

	private renderComposerSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Composer").setHeading();

		new Setting(containerEl)
			.setName("Send shortcut")
			.setDesc("Which key sends the message. The other inserts a newline.")
			.addDropdown((d) =>
				d
					.addOption("enter", "Enter (Shift+Enter for newline)")
					.addOption("cmdEnter", "⌘↵ / Ctrl+Enter (Enter for newline)")
					.setValue(this.plugin.settings.sendMethod)
					.onChange(async (value) => {
						this.plugin.settings.sendMethod = value as SendMethod;
						await this.plugin.saveSettings();
						this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).forEach((leaf) => {
							const view = leaf.view;
							if (view instanceof ChatView) view.refreshComposerHints();
						});
					})
			);
	}

	private renderContextSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Context").setHeading();

		new Setting(containerEl)
			.setName("Auto-attach active note")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoAttachActiveNote).onChange(async (value) => {
					this.plugin.settings.autoAttachActiveNote = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Prefer selection when present")
			.setDesc("Attach only the selected text instead of the whole note when there's a selection.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.preferSelection).onChange(async (value) => {
					this.plugin.settings.preferSelection = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max attachment size (kilobytes)")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxAttachKB)).onChange(async (value) => {
					const num = Number(value);
					if (Number.isFinite(num) && num > 0) {
						this.plugin.settings.maxAttachKB = Math.floor(num);
						await this.plugin.saveSettings();
					}
				})
			);
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Verbose logging")
			.setDesc("Print stream events and diagnostics to the developer console.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.verboseLogging).onChange(async (value) => {
					this.plugin.settings.verboseLogging = value;
					await this.plugin.saveSettings();
				})
			);

		const paths = resolvePaths(this.plugin);
		new Setting(containerEl)
			.setName("Permission hook directory")
			.setDesc(paths.tmpDir)
			.addButton((b) =>
				b.setButtonText("Show").onClick(() => {
					const shellApi = getElectronShell();
					if (shellApi?.openPath) void shellApi.openPath(paths.tmpDir);
				})
			);

		new Setting(containerEl)
			.setName("Reset plugin data")
			.setDesc("Delete the binary, config, and saved chats. You will need to install and sign in again.")
			.addButton((b) =>
				b.setWarning().setButtonText("Reset…").onClick(() => {
					void (async () => {
						const ok = await confirm(this.app, "Delete all plugin data? This cannot be undone.");
						if (!ok) return;
						await this.plugin.resetAllData();
						new Notice("Plugin data cleared.");
						this.display();
					})();
				})
			);
	}
}

class LoginModal extends Modal {
	private statusEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private cancelBtn!: HTMLButtonElement;
	private completed = false;

	constructor(app: App, private plugin: ClaudeCodePlugin, private onSettled: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Sign in to Claude" });
		this.statusEl = contentEl.createEl("p", { text: "Starting login…" });
		this.detailEl = contentEl.createDiv({ cls: "cc-login__detail" });
		const actions = contentEl.createDiv({ cls: "cc-modal__actions" });
		this.cancelBtn = actions.createEl("button", { text: "Cancel" });
		this.cancelBtn.addEventListener("click", () => this.close());

		void this.plugin.auth.beginLogin({
			onPhase: (phase, info) => this.handlePhase(phase, info),
		}).catch((e: unknown) => {
			this.handlePhase("failed", { message: (e as Error).message });
		});
	}

	onClose(): void {
		if (!this.completed) this.plugin.auth.cancelLogin();
		this.onSettled();
	}

	private handlePhase(
		phase: LoginPhase,
		info?: { url?: string; command?: string; message?: string }
	): void {
		this.detailEl.empty();
		switch (phase) {
			case "starting":
				this.statusEl.setText("Starting Claude Code…");
				break;
			case "waiting_browser":
				this.statusEl.setText(
					"A browser window should have opened. Complete sign-in there; this window updates automatically."
				);
				if (info?.url) {
					const link = this.detailEl.createEl("a", { text: "Open sign-in page again", href: info.url });
					link.target = "_blank";
				}
				break;
			case "success":
				this.completed = true;
				this.statusEl.setText("Signed in.");
				this.cancelBtn.setText("Close");
				break;
			case "cancelled":
				this.completed = true;
				this.statusEl.setText("Cancelled.");
				this.cancelBtn.setText("Close");
				break;
			case "failed":
				this.completed = true;
				this.statusEl.setText(info?.message ?? "Login failed.");
				this.cancelBtn.setText("Close");
				break;
		}
	}
}
