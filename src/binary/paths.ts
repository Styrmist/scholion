import { FileSystemAdapter } from "obsidian";
import { join } from "path";
import type ClaudeCodePlugin from "../main";
import {
	BINARY_NAME_UNIX,
	BINARY_NAME_WINDOWS,
	INSTALLED_RECORD_FILE,
	PARTIAL_DOWNLOAD_FILE,
	PLUGIN_DIR_BIN,
	PLUGIN_DIR_CONFIG,
	PLUGIN_DIR_SESSIONS,
	PLUGIN_DIR_TMP,
	PREVIOUS_BINARY_FILE_UNIX,
	PREVIOUS_BINARY_FILE_WINDOWS,
} from "../constants";
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
	const tmpDir = join(pluginDir, PLUGIN_DIR_TMP);
	const win = isWindows();
	const binaryPath = join(binDir, win ? BINARY_NAME_WINDOWS : BINARY_NAME_UNIX);
	const previousBinaryPath = join(binDir, win ? PREVIOUS_BINARY_FILE_WINDOWS : PREVIOUS_BINARY_FILE_UNIX);
	const partialDownloadPath = join(binDir, PARTIAL_DOWNLOAD_FILE);
	const installedRecordPath = join(binDir, INSTALLED_RECORD_FILE);

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
	};
}
