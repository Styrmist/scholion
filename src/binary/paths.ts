import { FileSystemAdapter } from "obsidian";
import { tmpdir } from "os";
import { join } from "path";
import type ClaudeCodePlugin from "../main";
import {
	BINARY_NAME_UNIX,
	BINARY_NAME_WINDOWS,
	HOOK_IPC_DIR_PREFIX,
	HOOK_SCRIPT_FILE_UNIX,
	HOOK_SCRIPT_FILE_WINDOWS,
	INSTALLED_RECORD_FILE,
	PARTIAL_DOWNLOAD_FILE,
	PLUGIN_DIR_BIN,
	PLUGIN_DIR_CONFIG,
	PLUGIN_DIR_SESSIONS,
	PREVIOUS_BINARY_FILE_UNIX,
	PREVIOUS_BINARY_FILE_WINDOWS,
} from "../constants";
import { hashString } from "../utils/fs";
import { isWindows } from "./platform";

export interface PluginPaths {
	vaultRoot: string;
	pluginDir: string;
	binDir: string;
	configDir: string;
	sessionsDir: string;
	tmpDir: string;
	binaryPath: string;
	previousBinaryPath: string;
	partialDownloadPath: string;
	installedRecordPath: string;
	hookScriptPath: string;
}

export function resolvePaths(plugin: ClaudeCodePlugin): PluginPaths {
	const adapter = plugin.app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		throw new Error("Claude Code plugin requires a desktop vault (FileSystemAdapter).");
	}
	const vaultRoot = adapter.getBasePath();
	const pluginDir = join(vaultRoot, plugin.app.vault.configDir, "plugins", plugin.manifest.id);
	const binDir = join(pluginDir, PLUGIN_DIR_BIN);
	const configDir = join(pluginDir, PLUGIN_DIR_CONFIG);
	const sessionsDir = join(pluginDir, PLUGIN_DIR_SESSIONS);
	// IPC dir lives outside the vault — see HOOK_IPC_DIR_PREFIX in constants.ts.
	// 16 hex of sha256(vaultRoot) is enough keyspace to avoid collisions across
	// any vaults a single user might open while keeping paths short on Windows.
	const tmpDir = join(tmpdir(), `${HOOK_IPC_DIR_PREFIX}${hashString(vaultRoot).slice(0, 16)}`);
	const win = isWindows();
	const binaryPath = join(binDir, win ? BINARY_NAME_WINDOWS : BINARY_NAME_UNIX);
	const previousBinaryPath = join(binDir, win ? PREVIOUS_BINARY_FILE_WINDOWS : PREVIOUS_BINARY_FILE_UNIX);
	const partialDownloadPath = join(binDir, PARTIAL_DOWNLOAD_FILE);
	const installedRecordPath = join(binDir, INSTALLED_RECORD_FILE);
	const hookScriptPath = join(binDir, win ? HOOK_SCRIPT_FILE_WINDOWS : HOOK_SCRIPT_FILE_UNIX);

	return {
		vaultRoot,
		pluginDir,
		binDir,
		configDir,
		sessionsDir,
		tmpDir,
		binaryPath,
		previousBinaryPath,
		partialDownloadPath,
		installedRecordPath,
		hookScriptPath,
	};
}
