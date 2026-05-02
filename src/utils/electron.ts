import { Platform } from "obsidian";

/**
 * Subset of Electron's `shell` API we use for opening URLs and paths in the
 * user's default handler. Methods are optional because we cross-load via
 * `require("electron")` from inside Obsidian's renderer; the runtime shape
 * depends on Electron's version and we don't want to crash if a method moves.
 */
export interface ElectronShell {
	openExternal?: (url: string) => Promise<void>;
	/** Opens the given absolute path in Finder / Explorer / file manager. */
	openPath?: (path: string) => Promise<string>;
}

export function getElectronShell(): ElectronShell | null {
	if (!Platform.isDesktopApp) return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const electron = require("electron") as { shell?: ElectronShell };
		return electron?.shell ?? null;
	} catch {
		return null;
	}
}
