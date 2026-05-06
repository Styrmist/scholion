import { spawn } from "child_process";
import { chmodSync, existsSync, promises as fsp, renameSync, unlinkSync } from "fs";
import { Notice } from "obsidian";
import { PARTIAL_STALE_AGE_MS, STALE_PREVIOUS_BINARY_AGE_MS } from "../../../constants";
import type ClaudeCodePlugin from "../../../main";
import { ClaudePlatform, InstalledRecord } from "../../../types";
import { atomicWriteJson, ensureDir, fileAgeMs, downloadToFileWithHash, readJsonIfExists } from "../../../utils/fs";
import * as logger from "../../../utils/log";
import { detectPlatform, isWindows } from "./platform";
import { PluginPaths, resolvePaths } from "./paths";
import { verifyManifestSignature } from "./verify";
import {
	binaryUrl,
	fetchLatestVersion,
	fetchManifestSignature,
	fetchManifestWithRaw,
	manifestChecksum,
} from "./versions";

export interface InstallProgress {
	receivedBytes: number;
	totalBytes: number | null;
}

export class BinaryInstaller {
	private installing = false;

	constructor(private plugin: ClaudeCodePlugin) {}

	get paths(): PluginPaths {
		return resolvePaths(this.plugin);
	}

	get platform(): ClaudePlatform {
		return detectPlatform();
	}

	async getInstalledVersion(): Promise<string | null> {
		const record = await readJsonIfExists<InstalledRecord>(this.paths.installedRecordPath);
		if (!record) return null;
		if (!existsSync(this.paths.binaryPath)) return null;
		return record.version;
	}

	async ensureBinary(): Promise<{ path: string; version: string }> {
		this.cleanupStaleArtifacts();
		const version = await this.getInstalledVersion();
		if (version) {
			return { path: this.paths.binaryPath, version };
		}
		throw new BinaryNotInstalledError();
	}

	/**
	 * Idempotent sweep for leftover install artifacts. Safe to call from plugin
	 * load and from `ensureBinary`. On Windows the previous-binary file can stay
	 * locked by a running Obsidian, so an in-place upgrade leaves it on disk —
	 * we retry-unlink anything older than 24h. The partial-download sweep is
	 * cross-platform.
	 */
	cleanupStaleArtifacts(): void {
		this.cleanupStalePartial();
		this.cleanupStalePreviousBinary();
	}

	async install(opts: { version?: string; onProgress?: (p: InstallProgress) => void } = {}): Promise<InstalledRecord> {
		if (this.installing) throw new Error("An install is already in progress.");
		this.installing = true;
		try {
			const platform = this.platform;
			const version = opts.version ?? (await fetchLatestVersion());
			logger.log("Installing claude binary", { version, platform });

			const { text: manifestText, parsed: manifest } = await fetchManifestWithRaw(version);
			const signature = await fetchManifestSignature(version);
			await verifyManifestSignature(manifestText, signature);
			const expectedSha = manifestChecksum(manifest, platform);
			const url = binaryUrl(version, platform);

			ensureDir(this.paths.binDir);
			this.cleanupStalePartial();
			if (existsSync(this.paths.partialDownloadPath)) {
				try { unlinkSync(this.paths.partialDownloadPath); } catch { /* ignore */ }
			}

			const { sha256 } = await downloadToFileWithHash(
				url,
				this.paths.partialDownloadPath,
				(received, total) => opts.onProgress?.({ receivedBytes: received, totalBytes: total })
			);

			if (sha256.toLowerCase() !== expectedSha) {
				try { unlinkSync(this.paths.partialDownloadPath); } catch { /* ignore */ }
				throw new Error(
					`Checksum mismatch: expected ${expectedSha}, got ${sha256}. The download was rejected.`
				);
			}

			if (!isWindows()) chmodSync(this.paths.partialDownloadPath, 0o755);

			if (existsSync(this.paths.binaryPath)) {
				try {
					if (existsSync(this.paths.previousBinaryPath)) unlinkSync(this.paths.previousBinaryPath);
					renameSync(this.paths.binaryPath, this.paths.previousBinaryPath);
				} catch (e) {
					logger.warn("Could not move previous binary aside", e);
				}
			}
			renameSync(this.paths.partialDownloadPath, this.paths.binaryPath);

			const record: InstalledRecord = {
				version,
				sha256,
				platform,
				installedAt: Date.now(),
			};
			await atomicWriteJson(this.paths.installedRecordPath, record);

			const ok = await this.selfCheck();
			if (!ok) {
				throw new Error("Installed binary failed --version self-check.");
			}

			new Notice(`Claude Code ${version} installed.`);
			return record;
		} finally {
			this.installing = false;
		}
	}

	async update(opts: { onProgress?: (p: InstallProgress) => void } = {}): Promise<InstalledRecord> {
		const latest = await fetchLatestVersion();
		const current = await this.getInstalledVersion();
		if (current === latest) {
			new Notice(`Claude Code is already at ${current}.`);
			return (await readJsonIfExists<InstalledRecord>(this.paths.installedRecordPath))!;
		}
		return this.install({ version: latest, onProgress: opts.onProgress });
	}

	async checkForUpdate(): Promise<{ latest: string; current: string | null; updateAvailable: boolean }> {
		const [latest, current] = await Promise.all([fetchLatestVersion(), this.getInstalledVersion()]);
		return { latest, current, updateAvailable: current !== latest };
	}

	async resetInstall(): Promise<void> {
		const { binaryPath, previousBinaryPath, installedRecordPath, partialDownloadPath } = this.paths;
		for (const p of [binaryPath, previousBinaryPath, installedRecordPath, partialDownloadPath]) {
			try { if (existsSync(p)) await fsp.unlink(p); } catch { /* ignore */ }
		}
	}

	private cleanupStalePartial(): void {
		const partial = this.paths.partialDownloadPath;
		if (!existsSync(partial)) return;
		const age = fileAgeMs(partial);
		if (age === null || age > PARTIAL_STALE_AGE_MS) {
			try { unlinkSync(partial); } catch { /* ignore */ }
		}
	}

	/**
	 * Windows-only: a failed/aborted install can leave `claude.prev.exe` on
	 * disk while Obsidian holds a lock on the spawned binary. Drop anything
	 * older than 24h. `EBUSY`/`EPERM` are expected when the file is still in
	 * use by a sibling process and must not be surfaced as errors.
	 */
	private cleanupStalePreviousBinary(): void {
		if (!isWindows()) return;
		const path = this.paths.previousBinaryPath;
		if (!existsSync(path)) return;
		const age = fileAgeMs(path);
		if (!shouldRemoveStalePreviousBinary(age, STALE_PREVIOUS_BINARY_AGE_MS)) return;
		try {
			unlinkSync(path);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOENT") {
				logger.warn("could not remove stale claude.prev.exe", e);
			}
		}
	}

	private selfCheck(): Promise<boolean> {
		return new Promise((resolve) => {
			const child = spawn(this.paths.binaryPath, ["--version"], {
				cwd: this.paths.binDir,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let buf = "";
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (c: string) => { buf += c; });
			// Drain stderr to avoid pipe-full deadlock on talkative CLIs.
			child.stderr?.resume();
			child.on("error", () => resolve(false));
			child.on("exit", (code) => {
				if (code === 0 && /\d+\.\d+\.\d+/.test(buf)) resolve(true);
				else resolve(false);
			});
		});
	}
}

export class BinaryNotInstalledError extends Error {
	constructor() {
		super("Claude Code binary is not installed. Open the plugin settings and click Install.");
		this.name = "BinaryNotInstalledError";
	}
}

/**
 * Pure decision: should we remove a previous-binary file based on its age?
 * `ageMs === null` means we couldn't stat it (file disappeared between
 * existsSync and stat, or some other transient FS hiccup) — be conservative
 * and skip. Otherwise drop anything past the threshold.
 */
export function shouldRemoveStalePreviousBinary(ageMs: number | null, thresholdMs: number): boolean {
	if (ageMs === null) return false;
	return ageMs > thresholdMs;
}
