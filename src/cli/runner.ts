import { ChildProcess, spawn } from "child_process";
import type ClaudeCodePlugin from "../main";
import { PROMPT_VIA_STDIN_THRESHOLD_BYTES } from "../constants";
import { SendOptions, SendResult } from "../types";
import * as logger from "../utils/log";
import { wireAbort } from "./abort";
import { buildIsolatedEnv } from "./env";
import { resolvePaths } from "../binary/paths";
import { normalize } from "./events";
import { lineStream } from "./ndjson";

export class ClaudeRunner {
	private active = new Set<ChildProcess>();

	constructor(private plugin: ClaudeCodePlugin) {}

	async send(opts: SendOptions): Promise<SendResult> {
		const promptBytes = Buffer.byteLength(opts.prompt, "utf8");
		const viaStdin = shouldSendPromptViaStdin(promptBytes, process.platform);
		const args = buildArgs(opts, { promptViaStdin: viaStdin });
		const env = this.buildEnv(opts.configDir);

		logger.log("Spawning claude", {
			argsCount: args.length,
			cwd: opts.cwd,
			configDir: opts.configDir,
			promptBytes,
			promptViaStdin: viaStdin,
			model: opts.model,
			resume: opts.resumeSessionId,
		});

		const spawnErrorBox: { error: Error | null } = { error: null };
		const child = spawn(opts.binaryPath, args, {
			cwd: opts.cwd,
			env,
			stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.on("error", (err) => { spawnErrorBox.error = err; });
		this.active.add(child);

		if (viaStdin && child.stdin) {
			child.stdin.on("error", (err) => {
				logger.warn("claude stdin write failed", err);
			});
			child.stdin.end(opts.prompt, "utf8");
		}

		const aborter = wireAbort(child, opts.signal);
		const stderrChunks: string[] = [];
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderrChunks.push(chunk);
			for (const line of chunk.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed) opts.onEvent({ kind: "stderr", line: trimmed });
			}
		});

		try {
			if (child.stdout) {
				for await (const raw of lineStream(child.stdout)) {
					for (const event of normalize(raw)) opts.onEvent(event);
				}
			}
			const exitCode = await new Promise<number | null>((resolve) => {
				if (child.exitCode !== null) {
					resolve(child.exitCode);
					return;
				}
				child.once("exit", (code) => resolve(code));
				child.once("error", () => resolve(null));
			});
			if (spawnErrorBox.error) {
				throw new Error(`Failed to spawn claude binary: ${spawnErrorBox.error.message}`);
			}
			return { exitCode, stderr: stderrChunks.join("") };
		} finally {
			this.active.delete(child);
			aborter.dispose();
		}
	}

	killAll(): void {
		for (const child of this.active) {
			try {
				if (process.platform === "win32") child.kill();
				else child.kill("SIGINT");
			} catch { /* ignore */ }
			setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
			}, 1500);
		}
		this.active.clear();
	}

	private buildEnv(configDir: string): NodeJS.ProcessEnv {
		const paths = resolvePaths(this.plugin);
		return buildIsolatedEnv({ configDir, tmpDir: paths.tmpDir });
	}
}

export interface BuildArgsOptions {
	/** When true, `-p` is passed without a positional prompt; caller pipes the prompt via stdin. */
	promptViaStdin?: boolean;
}

export function buildArgs(opts: SendOptions, buildOpts: BuildArgsOptions = {}): string[] {
	// cwd is set via spawn's options.cwd — there is no --cwd flag.
	const args: string[] = ["-p"];
	if (!buildOpts.promptViaStdin) args.push(opts.prompt);
	args.push(
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--include-hook-events",
		"--settings",
		opts.settingsJson,
	);
	if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
	// Permission lists are now consulted by the PreToolUse hook (HookServer)
	// instead of being passed to the CLI directly. The CLI's `--allowedTools`
	// would short-circuit the hook for matching tools, defeating interactivity.
	if (opts.model) args.push("--model", opts.model);
	if (opts.systemPromptAddendum && opts.systemPromptAddendum.trim()) {
		args.push("--append-system-prompt", opts.systemPromptAddendum);
	}
	return args;
}

/**
 * Windows' CreateProcessW caps the full command line around 32K UTF-16 chars,
 * so very long prompts (e.g. a pasted note) overflow argv. macOS/Linux limits
 * are an order of magnitude higher and not a real concern in practice. When
 * over the threshold we omit the positional prompt and feed it via stdin.
 */
export function shouldSendPromptViaStdin(promptByteLength: number, platform: NodeJS.Platform): boolean {
	if (platform !== "win32") return false;
	return promptByteLength > PROMPT_VIA_STDIN_THRESHOLD_BYTES;
}
