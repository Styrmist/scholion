import { randomBytes } from "crypto";
import { existsSync, promises as fsp, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type ClaudeCodePlugin from "../main";
import { resolvePaths } from "../providers/claude-code/binary/paths";
import { SESSION_SAVE_DEBOUNCE_MS } from "../constants";
import { ChatTurn, DiagnosticEntry, PermissionGrants, SessionMeta, SessionUsage } from "../types";
import { atomicWriteJson, ensureDir, readJsonIfExists } from "../utils/fs";

export interface SessionRecord {
	meta: SessionMeta;
	turns: ChatTurn[];
	permissions: PermissionGrants;
	diagnostics?: DiagnosticEntry[];
	usage?: SessionUsage;
	/**
	 * Marker set on session creation via fork: indicates how many of the
	 * leading entries in `turns` were inherited from the parent session.
	 * The first new turn after a fork includes those inherited turns in its
	 * prompt as a `<previous_conversation>` block so Claude has the context.
	 * Cleared (set to undefined) after the fork's first turn produces a
	 * CLI session id, so subsequent turns don't redundantly resend the
	 * history.
	 */
	forkedFromTurns?: number;
}

interface PendingSave {
	timer: ReturnType<typeof setTimeout>;
	record: SessionRecord;
}

export class SessionStore {
	private pendingSaves = new Map<string, PendingSave>();

	constructor(private plugin: ClaudeCodePlugin) {}

	private get sessionsDir(): string {
		return resolvePaths(this.plugin).sessionsDir;
	}

	private filePath(localId: string): string {
		return join(this.sessionsDir, `${localId}.json`);
	}

	list(): SessionMeta[] {
		const settings = this.plugin.settings;
		return [...settings.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async load(localId: string): Promise<SessionRecord | null> {
		ensureDir(this.sessionsDir);
		return readJsonIfExists<SessionRecord>(this.filePath(localId));
	}

	async saveImmediate(record: SessionRecord): Promise<void> {
		ensureDir(this.sessionsDir);
		await atomicWriteJson(this.filePath(record.meta.localId), record);
		this.upsertMeta(record.meta);
		await this.plugin.saveSettings();
	}

	scheduleSave(record: SessionRecord): void {
		const existing = this.pendingSaves.get(record.meta.localId);
		if (existing) clearTimeout(existing.timer);
		const timer = setTimeout(() => {
			this.pendingSaves.delete(record.meta.localId);
			void this.saveImmediate(record);
		}, SESSION_SAVE_DEBOUNCE_MS);
		this.pendingSaves.set(record.meta.localId, { timer, record });
	}

	async flushAll(): Promise<void> {
		const pending = Array.from(this.pendingSaves.values());
		this.pendingSaves.clear();
		for (const entry of pending) {
			clearTimeout(entry.timer);
			await this.saveImmediate(entry.record);
		}
	}

	/** Synchronous best-effort flush, safe to call from onunload. */
	flushAllSync(): void {
		const pending = Array.from(this.pendingSaves.values());
		this.pendingSaves.clear();
		const dir = this.sessionsDir;
		ensureDir(dir);
		for (const entry of pending) {
			clearTimeout(entry.timer);
			const path = this.filePath(entry.record.meta.localId);
			try {
				ensureDir(dirname(path));
				const tmp = `${path}.tmp`;
				writeFileSync(tmp, JSON.stringify(entry.record, null, 2), "utf8");
				renameSync(tmp, path);
				this.upsertMeta(entry.record.meta);
			} catch {
				// Best effort.
			}
		}
	}

	async rename(localId: string, title: string): Promise<void> {
		const record = await this.load(localId);
		if (!record) return;
		record.meta.title = title;
		record.meta.updatedAt = Date.now();
		await this.saveImmediate(record);
	}

	async delete(localId: string): Promise<void> {
		const path = this.filePath(localId);
		if (existsSync(path)) await fsp.unlink(path);
		const settings = this.plugin.settings;
		settings.sessions = settings.sessions.filter((s) => s.localId !== localId);
		await this.plugin.saveSettings();
	}

	createMeta(cwd: string): SessionMeta {
		const localId = makeLocalId();
		const now = Date.now();
		return {
			localId,
			title: "New chat",
			createdAt: now,
			updatedAt: now,
			cwd,
		};
	}

	private upsertMeta(meta: SessionMeta): void {
		const settings = this.plugin.settings;
		const idx = settings.sessions.findIndex((s) => s.localId === meta.localId);
		if (idx >= 0) settings.sessions[idx] = meta;
		else settings.sessions.push(meta);
	}
}

function makeLocalId(): string {
	return `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}
