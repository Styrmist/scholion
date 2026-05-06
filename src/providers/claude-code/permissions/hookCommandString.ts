/**
 * Build the `command` string for the CLI's `hooks.PreToolUse[].hooks[].command` entry.
 *
 * The CLI runs the command through a shell (`sh -c` on Unix, `cmd.exe /c` on
 * Windows). On Unix the script is directly executable via its `#!/bin/sh`
 * shebang. On Windows we explicitly invoke PowerShell since `.ps1` files
 * aren't directly executable from cmd by default.
 *
 * Embedded double quotes in paths are escaped defensively, though vault paths
 * containing literal `"` are extremely unusual.
 */
export function buildHookCommand(scriptPath: string): string {
	return buildHookCommandFor(process.platform, scriptPath);
}

/** Platform-explicit form of buildHookCommand for testing both branches. */
export function buildHookCommandFor(platform: NodeJS.Platform, scriptPath: string): string {
	if (platform === "win32") {
		return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quote(scriptPath)}`;
	}
	return quote(scriptPath);
}

export function quote(p: string): string {
	const escaped = p.replace(/"/g, '\\"');
	return `"${escaped}"`;
}
