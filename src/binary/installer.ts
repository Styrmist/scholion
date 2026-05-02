import { spawn } from "child_process";
import { chmodSync, existsSync, promises as fsp, renameSync, unlinkSync } from "fs";
import { Notice } from "obsidian";
import { PARTIAL_STALE_AGE_MS } from "../constants";
import type ClaudeCodePlugin from "../main";
import { ClaudePlatform, InstalledRecord } from "../types";
import { atomicWriteJson, ensureDir, fileAgeMs, downloadToFileWithHash, readJsonIfExists } from "../utils/fs";
import * as logger from "../utils/log";
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
		this.cleanupStalePartial();
		const version = await this.getInstalledVersion();
		if (version) {
			return { path: this.paths.binaryPath, version };
		}
		throw new BinaryNotInstalledError();
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
