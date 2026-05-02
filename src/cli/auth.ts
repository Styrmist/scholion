import { ChildProcess, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Notice } from "obsidian";
import { STDOUT_OAUTH_URL_PATTERN } from "../constants";
import type ClaudeCodePlugin from "../main";
import { getElectronShell } from "../utils/electron";
import * as logger from "../utils/log";
import { resolvePaths } from "../binary/paths";
import { buildIsolatedEnv } from "./env";

/**
 * Returns whether a logged-in `oauthAccount` block is present in
 * <configDir>/.claude.json. This is the only cross-platform "signed in"
 * signal we can rely on — on macOS the actual OAuth tokens go to a
 * per-config-dir-suffixed Keychain entry (e.g. "Claude Code-credentials-<hash>"),
 * so checking the file system alone via `.credentials.json` doesn't work there.
 */
function hasOauthAccount(configDir: string): boolean {
	const path = join(configDir, ".claude.json");
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
		return Boolean(parsed?.oauthAccount?.emailAddress);
	} catch {
		return false;
	}
}


export type LoginPhase =
	| "starting"
	| "waiting_browser"
	| "success"
	| "cancelled"
	| "failed";

export interface LoginEvents {
	onPhase: (
		phase: LoginPhase,
		info?: { url?: string; message?: string }
	) => void;
}

const CREDENTIAL_POLL_INTERVAL_MS = 1_500;
const CREDENTIAL_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

export class AuthManager {
	private currentChild: ChildProcess | null = null;
	private credPollTimer: ReturnType<typeof setInterval> | null = null;
	private cancelled = false;

	constructor(private plugin: ClaudeCodePlugin) {}

	async isAuthenticated(): Promise<boolean> {
		const { configDir, binaryPath } = resolvePaths(this.plugin);
		if (!existsSync(binaryPath)) return false;
		return hasOauthAccount(configDir);
	}

	getSignedInEmail(): string | null {
		const { configDir } = resolvePaths(this.plugin);
		const path = join(configDir, ".claude.json");
		if (!existsSync(path)) return null;
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
			return parsed?.oauthAccount?.emailAddress ?? null;
		} catch {
			return null;
		}
	}

	async beginLogin(events: LoginEvents): Promise<void> {
		if (this.currentChild || this.credPollTimer) {
			throw new Error("Login already in progress.");
		}
		const { binaryPath, configDir } = resolvePaths(this.plugin);
		if (!existsSync(binaryPath)) throw new Error("Binary not installed.");
		this.cancelled = false;
		events.onPhase("starting");

		// `claude auth login --claudeai` runs fully headlessly:
		//   - prints "Opening browser to sign in…" + the OAuth URL on stdout,
		//   - spawns a localhost HTTP server for the OAuth callback,
		//   - exits 0 after writing credentials.
		// We open the URL ourselves via Electron in case the OS-level `open`
		// from the subprocess can't reach the user's default browser.
		const child = spawn(binaryPath, ["auth", "login", "--claudeai"], {
			cwd: configDir,
			env: this.buildEnv(configDir),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.currentChild = child;

		let urlOpened = false;
		const stderrBuf: string[] = [];

		const onText = (text: string) => {
			logger.log("[auth]", redactSecrets(text));
			if (urlOpened) return;
			const match = text.match(STDOUT_OAUTH_URL_PATTERN);
			if (match) {
				urlOpened = true;
				const url = match[0];
				void this.openInBrowser(url);
				events.onPhase("waiting_browser", { url });
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => onText(c));
		child.stderr?.on("data", (c: string) => { stderrBuf.push(c); onText(c); });

		try {
			await this.waitForCredentialsOrExit(child, configDir, stderrBuf);
			if (this.cancelled) return this.emitCancelled(events);
			events.onPhase("success");
		} catch (e) {
			if (this.cancelled) return this.emitCancelled(events);
			events.onPhase("failed", { message: (e as Error).message });
		} finally {
			this.terminateChild();
			this.stopCredPoll();
		}
	}

	cancelLogin(): void {
		this.cancelled = true;
		this.terminateChild();
		this.stopCredPoll();
	}

	async logout(): Promise<void> {
		const { binaryPath, configDir } = resolvePaths(this.plugin);
		if (!existsSync(binaryPath)) return;
		await new Promise<void>((resolve) => {
			const child = spawn(binaryPath, ["auth", "logout"], {
				cwd: configDir,
				env: this.buildEnv(configDir),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			child.stdout?.resume();
			child.stderr?.resume();
			child.on("exit", () => resolve());
			child.on("error", () => resolve());
		});
		// Belt-and-braces: ensure the oauthAccount block is gone even if the
		// subprocess failed. Don't delete the whole file — it carries other state.
		try {
			const file = join(configDir, ".claude.json");
			if (existsSync(file)) {
				const raw = readFileSync(file, "utf8");
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				if ("oauthAccount" in parsed) {
					delete parsed.oauthAccount;
					const fsp = await import("fs/promises");
					await fsp.writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
				}
			}
		} catch { /* ignore */ }
	}

	private async openInBrowser(url: string): Promise<void> {
		const shellApi = getElectronShell();
		if (shellApi?.openExternal) {
			try {
				await shellApi.openExternal(url);
				return;
			} catch { /* fall through */ }
		}
		new Notice(`Open this URL to log in: ${url}`);
	}

	/**
	 * Resolves when the .claude.json file shows oauthAccount populated, OR
	 * rejects when the child process exits non-zero before that.
	 */
	private waitForCredentialsOrExit(
		child: ChildProcess,
		configDir: string,
		stderrBuf: string[]
	): Promise<void> {
		return new Promise((resolve, reject) => {
			if (hasOauthAccount(configDir)) { resolve(); return; }
			const deadline = Date.now() + CREDENTIAL_POLL_TIMEOUT_MS;

			const finishOk = () => {
				this.stopCredPoll();
				child.removeListener("exit", onExit);
				resolve();
			};
			const finishErr = (e: Error) => {
				this.stopCredPoll();
				child.removeListener("exit", onExit);
				reject(e);
			};

			const onExit = (code: number | null) => {
				// Brief grace window — the token write race-loses to exit by a few ms.
				setTimeout(() => {
					if (hasOauthAccount(configDir)) finishOk();
					else if (code === 0) finishErr(new Error("Login process exited without writing credentials."));
					else finishErr(new Error(stderrBuf.join("").trim() || `Login process exited with code ${code}.`));
				}, 300);
			};
			child.once("exit", onExit);

			this.credPollTimer = setInterval(() => {
				if (this.cancelled) {
					finishErr(new Error("Cancelled."));
					return;
				}
				if (hasOauthAccount(configDir)) {
					finishOk();
					return;
				}
				if (Date.now() > deadline) {
					finishErr(new Error("Login timed out after 10 minutes."));
				}
			}, CREDENTIAL_POLL_INTERVAL_MS);
		});
	}

	private stopCredPoll(): void {
		if (this.credPollTimer !== null) {
			clearInterval(this.credPollTimer);
			this.credPollTimer = null;
		}
	}

	private terminateChild(): void {
		if (!this.currentChild) return;
		const child = this.currentChild;
		this.currentChild = null;
		try {
			if (process.platform === "win32") child.kill();
			else child.kill("SIGINT");
		} catch { /* ignore */ }
		setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* ignore */ }
		}, 1500);
	}

	private emitCancelled(events: LoginEvents): void {
		events.onPhase("cancelled");
	}

	private buildEnv(configDir: string): NodeJS.ProcessEnv {
		const paths = resolvePaths(this.plugin);
		return buildIsolatedEnv({ configDir, tmpDir: paths.tmpDir });
	}
}

function redactSecrets(text: string): string {
	return text
		.replace(/code=[\w-]+/gi, "code=<redacted>")
		.replace(/access_token[^\s"']+/gi, "access_token=<redacted>")
		.replace(/refresh_token[^\s"']+/gi, "refresh_token=<redacted>");
}
