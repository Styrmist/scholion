import type { SessionId } from "../backend/ids";
import type { PermissionMode } from "../types";

export interface ClaudeNativeContext {
	// Assigned by the CLI on system_init; needed for --resume.
	nativeId?: string;
	cwd: string;
	model?: string;
	systemPromptAddendum?: string;
	permissionMode: PermissionMode;
}

export class ClaudeSessionMap {
	private readonly map = new Map<SessionId, ClaudeNativeContext>();

	get(id: SessionId): ClaudeNativeContext | undefined {
		return this.map.get(id);
	}

	getOrInit(id: SessionId, init: () => ClaudeNativeContext): ClaudeNativeContext {
		const existing = this.map.get(id);
		if (existing) return existing;
		const created = init();
		this.map.set(id, created);
		return created;
	}

	upsert(id: SessionId, patch: Partial<ClaudeNativeContext>): ClaudeNativeContext {
		const existing = this.map.get(id) ?? this.defaultContext();
		const next: ClaudeNativeContext = { ...existing, ...patch };
		this.map.set(id, next);
		return next;
	}

	delete(id: SessionId): void {
		this.map.delete(id);
	}

	has(id: SessionId): boolean {
		return this.map.has(id);
	}

	hasNativeId(id: SessionId): boolean {
		return Boolean(this.map.get(id)?.nativeId);
	}

	private defaultContext(): ClaudeNativeContext {
		return { cwd: "", permissionMode: "default" };
	}
}
