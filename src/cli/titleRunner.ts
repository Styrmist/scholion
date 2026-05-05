import { spawn } from "child_process";
import { resolvePaths } from "../binary/paths";
import type ClaudeCodePlugin from "../main";
import { TITLE_SYSTEM_PROMPT } from "../session/titleSuggest";
import { buildIsolatedEnv } from "./env";

/** Hard ceiling on the titler subprocess. The flow is async and non-blocking,
 *  but a runaway call should be reaped so we don't accumulate orphan processes
 *  if the CLI hangs (offline, auth handshake stalls, etc.). */
const TITLE_TIMEOUT_MS = 30_000;

/** Per-call USD cap passed to `--max-budget-usd`. Cheap belt-and-braces on
 *  top of the model choice (haiku) — guarantees no titling can cost more
 *  than this even if a system-prompt regression blows up token counts. */
const TITLE_MAX_BUDGET_USD = "0.05";

export interface TitleRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

/**
 * Spawn the Haiku titling subprocess. Inherits the main runner's auth and
 * env-stripping but uses a neutral cwd (the plugin's bin dir) so CLAUDE.md
 * auto-discovery doesn't pull vault context into the titling prompt — the
 * cache stays warm across sessions and the cost stays predictable.
 *
 * Returns the raw stdout for `parseTitleResponse` to chew on. Failures
 * (non-zero exit, timeout, spawn error) come back as a populated stderr
 * with `exitCode === null` (timeout/spawn-error) or non-zero exit code.
 */
export async function runTitleSubprocess(
	plugin: ClaudeCodePlugin,
	prompt: string,
): Promise<TitleRunResult> {
	const paths = resolvePaths(plugin);
	const env = buildIsolatedEnv({ configDir: paths.configDir, tmpDir: paths.tmpDir });
	const args = [
		"-p", prompt,
		"--model", "haiku",
		"--output-format", "json",
		"--no-session-persistence",
		"--tools", "",
		"--max-budget-usd", TITLE_MAX_BUDGET_USD,
		"--settings", "{}",
		"--append-system-prompt", TITLE_SYSTEM_PROMPT,
		"--exclude-dynamic-system-prompt-sections",
	];
	return new Promise((resolve) => {
		const child = spawn(paths.binaryPath, args, {
			cwd: paths.binDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => { stdout += c; });
		child.stderr?.on("data", (c: string) => { stderr += c; });
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
			setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1500);
		}, TITLE_TIMEOUT_MS);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr + (stderr ? "\n" : "") + e.message, exitCode: null, timedOut });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code, timedOut });
		});
	});
}
