import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { dirname, join } from "path";
import { ensureDir } from "../utils/fs";
import * as logger from "../utils/log";
import { HOOK_SCRIPT_UNIX, HOOK_SCRIPT_WINDOWS } from "./hookScriptSource";

/**
 * Idempotent install of the platform-correct hook script. Writes the script
 * (sh on macOS/Linux, PowerShell on Windows) at the path configured by
 * resolvePaths. Compares content-hash to avoid spurious rewrites that would
 * trip iCloud sync churn. Also cleans up the legacy node-based script if
 * present (transition from earlier plugin versions).
 */
export async function installHookScript(scriptPath: string): Promise<void> {
	const isWindows = process.platform === "win32";
	const source = isWindows ? HOOK_SCRIPT_WINDOWS : HOOK_SCRIPT_UNIX;
	ensureDir(dirname(scriptPath));
	const wantHash = createHash("sha256").update(source, "utf8").digest("hex");
	let needsWrite = true;
	try {
		const onDisk = await fsp.readFile(scriptPath, "utf8");
		const haveHash = createHash("sha256").update(onDisk, "utf8").digest("hex");
		needsWrite = haveHash !== wantHash;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") logger.warn("hook script read failed", err);
	}

	if (needsWrite) {
		const tmp = `${scriptPath}.tmp`;
		await fsp.writeFile(tmp, source, "utf8");
		await fsp.rename(tmp, scriptPath);
		if (!isWindows) {
			try { await fsp.chmod(scriptPath, 0o755); } catch (e) { logger.warn("hook script chmod failed", e); }
		}
		logger.log("hook script installed", { scriptPath, bytes: source.length });
	}

	// Clean up legacy node-based script from earlier plugin versions.
	const legacy = join(dirname(scriptPath), "permissionHook.cjs");
	try { await fsp.unlink(legacy); } catch { /* ignore */ }
}
