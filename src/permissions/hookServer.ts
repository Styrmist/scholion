import { promises as fsp } from "fs";
import { join } from "path";
import { resolvePaths } from "../binary/paths";
import type ClaudeCodePlugin from "../main";
import type { SessionRecord } from "../session/store";
import { ensureDir } from "../utils/fs";
import * as logger from "../utils/log";
import {
	HookDecision,
	HookRequest,
	HookResponseFile,
	isReqFile,
	respFileName,
	toolUseIdFromReqFile,
} from "./hookProtocol";

/**
 * What the plugin needs to know to make a permission decision (or escalate to UI).
 * Read by the server before resolving — the server itself is UI-agnostic.
 */
export interface PermissionContext {
	/** The active session's record, if any. Per-session grants live here. */
	getRecord(): SessionRecord | null;
	/** Plugin global allow/deny lists. */
	getGlobalAllowed(): string[];
	getGlobalDenied(): string[];
}

/** Escalation target: the coordinator owns mid-stream UI flow. */
export interface PermissionEscalator {
	/**
	 * A tool call needs a user decision. Return true if the escalator accepted
	 * the request (must eventually call HookServer.respond). Return false to
	 * indicate the request couldn't be handled (e.g. wrong state) — the server
	 * will then deny on its own to release the CLI.
	 */
	requestDecision(request: HookRequest): boolean;
}

/**
 * File-IPC mediator between the CLI's PreToolUse hook script and the plugin.
 * The IPC dir lives in system temp (see resolvePaths) — outside the vault to
 * avoid iCloud/cloud-sync interference with the script's atomic .tmp→.req
 * rename. Per-vault subdir keyed by sha256(vaultRoot) so two Obsidian instances
 * on different vaults can't collide.
 *
 * Lifecycle: started in main.onload, stopped in main.onunload. The active
 * coordinator is bound/unbound by ChatView.onOpen / onClose; if a request
 * arrives without a coordinator the server denies with a stable reason.
 *
 * Stale-cleanup: any pre-existing .req files at start time are denied
 * (their hook scripts, if still alive, will read the response and exit;
 * if dead, they're harmless leftovers).
 *
 * Known limitation: two Obsidian instances open on the same vault hash to the
 * same IPC dir; either instance can pick up the other's .req. Symptom is
 * over-permissive (the receiving instance's allow-list is used). Tracked in
 * TODO.md → Hook IPC follow-ups.
 */
export class HookServer {
	private tmpDir: string | null = null;
	private context: PermissionContext | null = null;
	private escalator: PermissionEscalator | null = null;
	private inflight = new Set<string>();
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(private plugin: ClaudeCodePlugin) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		const paths = resolvePaths(this.plugin);
		this.tmpDir = paths.tmpDir;
		void this.cleanupStaleArtifacts();
		// Pure polling — fs.watch on Electron's renderer was firing rename
		// events before the dir-entry commit was observable to readFile,
		// causing every parallel hook to fail with ENOENT inside our retry
		// budget. readdir-based polling only surfaces files whose dir-entry
		// has fully committed, so the subsequent readFile is guaranteed to
		// find the file. 60ms cadence is barely perceptible to the user
		// (hook scripts already poll their .resp at 150ms).
		this.pollInterval = setInterval(() => { void this.scanForRequests(); }, 60);
		logger.log("hook server started", { tmpDir: this.tmpDir });
	}

	stop(): void {
		this.running = false;
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		// Best-effort: deny any outstanding requests so blocked hook scripts can exit.
		if (this.tmpDir) {
			void this.denyAllOutstanding(this.tmpDir, "Plugin unloaded");
		}
		this.context = null;
		this.escalator = null;
		this.inflight.clear();
	}

	bindContext(context: PermissionContext, escalator: PermissionEscalator): void {
		this.context = context;
		this.escalator = escalator;
	}

	clearContext(): void {
		this.context = null;
		this.escalator = null;
	}

	respond(toolUseId: string, decision: HookDecision, reason?: string): void {
		const tmpDir = this.tmpDir;
		if (!tmpDir) {
			logger.warn("hook respond called with no tmpDir", { toolUseId });
			return;
		}
		logger.log("[resp] writing", { toolUseId, decision, reason });
		// IMPORTANT: do NOT delete from `inflight` here. The hook script's poll
		// interval is 150ms; our poller is 60ms. If we cleared inflight on
		// respond, the next 1-2 polls would see the still-present .req and
		// re-run handleRequest — which for escalated requests would open a
		// second prompt for the same tool, and for fast-path tools would
		// wastefully re-write the same .resp. inflight is pruned in
		// scanForRequests when the .req actually disappears (script cleanup).
		try { ensureDir(tmpDir); } catch (e) { logger.warn("hook tmpDir ensureDir failed", e); }
		void writeResponse(tmpDir, toolUseId, { decision, reason });
	}

	/**
	 * Polling-based scanner. Polled every 60ms from `start()`. Every entry that
	 * `readdir` reports has a fully-committed dir-entry, so the subsequent
	 * `readFile` is guaranteed to find the file content (the kernel doesn't
	 * report partial dir entries).
	 */
	private async scanForRequests(): Promise<void> {
		const tmpDir = this.tmpDir;
		if (!tmpDir || !this.running) return;
		let entries: string[];
		try {
			entries = await fsp.readdir(tmpDir);
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				try { ensureDir(tmpDir); } catch { /* ignore */ }
				return;
			}
			logger.warn("hook poller readdir failed", err);
			return;
		}
		const reqFiles = entries.filter(isReqFile);
		const presentIds = new Set<string>();
		for (const name of reqFiles) {
			const id = toolUseIdFromReqFile(name);
			if (id) presentIds.add(id);
		}

		// Prune inflight entries whose .req has been cleaned up by the hook
		// script (it removes both .req and .resp after reading our response).
		// This is what frees us to handle a future tool with the same id (very
		// unlikely) and bounds the inflight set size.
		for (const id of this.inflight) {
			if (!presentIds.has(id)) this.inflight.delete(id);
		}

		const newOnes = reqFiles.filter((n) => {
			const id = toolUseIdFromReqFile(n);
			return id !== null && !this.inflight.has(id);
		});
		if (newOnes.length > 0) {
			logger.log("[poll] new req files", {
				newCount: newOnes.length,
				totalReq: reqFiles.length,
				inflight: this.inflight.size,
				names: newOnes,
			});
		}
		for (const name of reqFiles) {
			const toolUseId = toolUseIdFromReqFile(name);
			if (!toolUseId) continue;
			if (this.inflight.has(toolUseId)) continue;
			this.inflight.add(toolUseId);
			void this.handleRequest(toolUseId, join(tmpDir, name));
		}
	}

	private async handleRequest(toolUseId: string, reqPath: string): Promise<void> {
		logger.log("[req] start", { toolUseId });
		let request: HookRequest | null = null;
		let lastError: { code?: string; type: string; msg?: string } | null = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const text = await fsp.readFile(reqPath, "utf8");
				if (text.length === 0) {
					lastError = { type: "empty" };
					logger.log("[req] read empty", { toolUseId, attempt });
					await delay(40);
					continue;
				}
				request = JSON.parse(text) as HookRequest;
				logger.log("[req] read OK", { toolUseId, attempt, tool: request.tool_name, bytes: text.length });
				break;
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				lastError = {
					code: err.code,
					type: e instanceof SyntaxError ? "SyntaxError" : (err.constructor?.name ?? "unknown"),
					msg: typeof err.message === "string" ? err.message.slice(0, 120) : undefined,
				};
				logger.log("[req] read err", { toolUseId, attempt, ...lastError });
				if (err.code === "ENOENT") {
					this.inflight.delete(toolUseId);
					return;
				}
				await delay(40);
			}
		}
		if (!request) {
			logger.warn("[req] FAIL after retries", { toolUseId, lastError });
			this.respond(toolUseId, "deny", "Plugin could not read hook request");
			return;
		}

		const decision = this.fastPath(request);
		if (decision) {
			logger.log("[req] fastPath", { toolUseId, tool: request.tool_name, decision: decision.decision, reason: decision.reason });
			this.respond(toolUseId, decision.decision, decision.reason);
			return;
		}

		const escalator = this.escalator;
		if (!escalator) {
			logger.warn("[req] no escalator -> deny", { toolUseId, tool: request.tool_name });
			this.respond(toolUseId, "deny", "No active chat view to handle permission request");
			return;
		}
		logger.log("[req] escalating", { toolUseId, tool: request.tool_name });
		const accepted = escalator.requestDecision(request);
		logger.log("[req] escalator returned", { toolUseId, accepted });
		if (!accepted) {
			this.respond(toolUseId, "deny", "Permission UI not available right now");
		}
	}

	private fastPath(request: HookRequest): { decision: HookDecision; reason?: string } | null {
		const ctx = this.context;
		if (!ctx) return null;
		const tool = request.tool_name;
		const record = ctx.getRecord();
		const sessionAllowed = record?.permissions.allowedTools ?? [];
		const sessionDenied = record?.permissions.deniedTools ?? [];
		if (matches(sessionDenied, tool)) return { decision: "deny", reason: "Tool denied for this session" };
		if (matches(ctx.getGlobalDenied(), tool)) return { decision: "deny", reason: "Tool denied globally" };
		if (matches(sessionAllowed, tool)) return { decision: "allow" };
		if (matches(ctx.getGlobalAllowed(), tool)) return { decision: "allow" };
		return null;
	}

	private async cleanupStaleArtifacts(): Promise<void> {
		const tmpDir = this.tmpDir;
		if (!tmpDir) return;
		try {
			const entries = await fsp.readdir(tmpDir);
			for (const name of entries) {
				const full = join(tmpDir, name);
				if (isReqFile(name)) {
					// Stale .req from a previous Obsidian session: write deny so
					// any still-running hook script can exit cleanly, then delete
					// the .req. (We can't tell here whether the script is alive.)
					const id = toolUseIdFromReqFile(name);
					if (id) {
						await writeResponse(tmpDir, id, {
							decision: "deny",
							reason: "Stale request from previous Obsidian session",
						});
					}
					try { await fsp.unlink(full); } catch { /* ignore */ }
				} else if (name.endsWith(".resp") || name.endsWith(".resp.tmp") || name.endsWith(".req.tmp")) {
					// Orphan response/temp files from previous runs. The hook
					// script that would have read them is long gone.
					try { await fsp.unlink(full); } catch { /* ignore */ }
				}
			}
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") logger.warn("hook stale cleanup failed", err);
		}
	}

	private async denyAllOutstanding(tmpDir: string, reason: string): Promise<void> {
		try {
			const entries = await fsp.readdir(tmpDir);
			for (const name of entries) {
				if (!isReqFile(name)) continue;
				const id = toolUseIdFromReqFile(name);
				if (!id) continue;
				await writeResponse(tmpDir, id, { decision: "deny", reason });
			}
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") logger.warn("hook deny-all cleanup failed", err);
		}
	}
}

async function writeResponse(tmpDir: string, toolUseId: string, payload: HookResponseFile): Promise<void> {
	const dest = join(tmpDir, respFileName(toolUseId));
	const tmp = `${dest}.tmp`;
	try {
		await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
		await fsp.rename(tmp, dest);
	} catch (e) {
		logger.warn("hook response write failed", { toolUseId, error: e });
	}
}

// Tool entries from `--allowedTools` look like `Bash` or `Bash(git *)`. The CLI
// matches them as patterns; for the plugin's fast-path we treat anything before
// the first paren as the tool name and accept either an exact match or the
// whole entry equal to the tool name.
function matches(list: string[], tool: string): boolean {
	for (const entry of list) {
		const head = entry.split("(", 1)[0]?.trim() ?? entry.trim();
		if (head === tool) return true;
	}
	return false;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
