import { ChildProcess, spawn } from "child_process";
import type ClaudeCodePlugin from "../main";
import { SendOptions, SendResult } from "../types";
import * as logger from "../utils/log";
import { wireAbort } from "./abort";
import { buildIsolatedEnv } from "./env";
import { normalize } from "./events";
import { lineStream } from "./ndjson";

export class ClaudeRunner {
	private active = new Set<ChildProcess>();

	constructor(private plugin: ClaudeCodePlugin) {}

	async send(opts: SendOptions): Promise<SendResult> {
		const args = this.buildArgs(opts);
		const env = this.buildEnv(opts.configDir);

		logger.log("Spawning claude", {
			argsCount: args.length,
			cwd: opts.cwd,
			configDir: opts.configDir,
			promptBytes: opts.prompt.length,
			model: opts.model,
			resume: opts.resumeSessionId,
		});

		const spawnErrorBox: { error: Error | null } = { error: null };
		const child = spawn(opts.binaryPath, args, {
			cwd: opts.cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.on("error", (err) => { spawnErrorBox.error = err; });
		this.active.add(child);

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

	private buildArgs(opts: SendOptions): string[] {
		// cwd is set via spawn's options.cwd — there is no --cwd flag.
		const args: string[] = [
			"-p",
			opts.prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--settings",
			opts.settingsJson,
		];
		if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
		if (opts.allowedTools.length > 0) args.push("--allowedTools", opts.allowedTools.join(","));
		if (opts.disallowedTools.length > 0) args.push("--disallowedTools", opts.disallowedTools.join(","));
		if (opts.model) args.push("--model", opts.model);
		if (opts.systemPromptAddendum && opts.systemPromptAddendum.trim()) {
			args.push("--append-system-prompt", opts.systemPromptAddendum);
		}
		return args;
	}

	private buildEnv(configDir: string): NodeJS.ProcessEnv {
		return buildIsolatedEnv(configDir);
	}
}
