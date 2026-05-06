import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../binary/paths", () => ({
	resolvePaths: () => ({
		vaultRoot: "/vault",
		configDir: "/vault/.obsidian/plugins/claude-code/config",
		binaryPath: "/vault/.obsidian/plugins/claude-code/bin/claude",
		binDir: "/vault/.obsidian/plugins/claude-code/bin",
		pluginDir: "/vault/.obsidian/plugins/claude-code",
		sessionsDir: "/vault/.obsidian/plugins/claude-code/sessions",
		tmpDir: "/tmp/obsidian-claude-code/v1",
		hookScriptPath: "/vault/.obsidian/plugins/claude-code/hook.sh",
		installedRecordPath:
			"/vault/.obsidian/plugins/claude-code/installed.json",
	}),
}));

import { ClaudeCodeBackend, type ClaudeBackendDeps } from "./backend";
import type { ClaudeRunner } from "./runner";
import type { AuthManager } from "./auth";
import type { HookServer } from "../permissions/hookServer";
import type { BinaryInstaller } from "../binary/installer";
import type { SessionStore, SessionRecord } from "../session/store";
import type { SendOptions, StreamEvent } from "../types";
import { sessionId, permReqId } from "../backend/ids";

type FakePlugin = {
	app: { vault: { configDir: string } };
	settings: {
		permissionMode: "default" | "acceptEdits" | "plan";
		systemPromptAddendum: string;
		allowedTools: string[];
		disallowedTools: string[];
	};
	saveSettings: () => Promise<void>;
	manifest: { dir: string };
};

const makeFakePlugin = (): FakePlugin => ({
	app: { vault: { configDir: ".obsidian" } },
	settings: {
		permissionMode: "default",
		systemPromptAddendum: "",
		allowedTools: [],
		disallowedTools: [],
	},
	saveSettings: async () => undefined,
	manifest: { dir: "/vault/.obsidian/plugins/claude-code" },
});

const makeRecord = (overrides?: Partial<SessionRecord>): SessionRecord => ({
	meta: {
		localId: "local-1",
		title: "Test",
		createdAt: 1,
		updatedAt: 1,
		cwd: "/repo",
	},
	turns: [],
	permissions: { allowedTools: [], deniedTools: [] },
	...overrides,
});

class FakeRunner {
	public lastOptions: SendOptions | null = null;
	private script: StreamEvent[] = [];

	queueScript(events: StreamEvent[]): void {
		this.script = events;
	}

	async send(opts: SendOptions): Promise<{ exitCode: number; stderr: string }> {
		this.lastOptions = opts;
		// Drain events synchronously into the callback so tests can observe them.
		for (const e of this.script) opts.onEvent(e);
		return { exitCode: 0, stderr: "" };
	}

	killAll(): void {}
}

class FakeStore {
	public records = new Map<string, SessionRecord>();
	saved: SessionRecord[] = [];

	async load(id: string): Promise<SessionRecord | null> {
		return this.records.get(id) ?? null;
	}
	async saveImmediate(record: SessionRecord): Promise<void> {
		this.records.set(record.meta.localId, record);
		this.saved.push(record);
	}
	list(): SessionRecord["meta"][] {
		return [...this.records.values()].map((r) => r.meta);
	}
	async delete(id: string): Promise<void> {
		this.records.delete(id);
	}
}

const makeDeps = (record?: SessionRecord): {
	deps: ClaudeBackendDeps;
	runner: FakeRunner;
	store: FakeStore;
	hookRespond: ReturnType<typeof vi.fn>;
} => {
	const runner = new FakeRunner();
	const store = new FakeStore();
	if (record) store.records.set(record.meta.localId, record);
	const hookRespond = vi.fn();
	const deps: ClaudeBackendDeps = {
		runner: runner as unknown as ClaudeRunner,
		auth: {
			isAuthenticated: async () => true,
			getSignedInEmail: () => "user@example.com",
			beginLogin: async () => undefined,
			logout: async () => undefined,
		} as unknown as AuthManager,
		hookServer: {
			respond: hookRespond,
			start: () => undefined,
			stop: () => undefined,
		} as unknown as HookServer,
		installer: {
			getInstalledVersion: async () => "2.1.116",
			install: async () => undefined,
			update: async () => undefined,
			paths: { configDir: "/cfg", binaryPath: "/bin/claude" },
		} as unknown as BinaryInstaller,
		sessions: store as unknown as SessionStore,
	};
	return { deps, runner, store, hookRespond };
};

const makeBackend = (record?: SessionRecord) => {
	const plugin = makeFakePlugin();
	const setup = makeDeps(record);
	const backend = new ClaudeCodeBackend(plugin as never, setup.deps);
	return { backend, plugin, ...setup };
};

afterEach(() => {
	vi.clearAllMocks();
});

describe("ClaudeCodeBackend identity", () => {
	it("reports id 'claude-code' and the full capability surface", () => {
		const { backend } = makeBackend();
		expect(backend.id()).toBe("claude-code");
		const c = backend.capabilities();
		expect(c.agentic).toBe(true);
		expect(c.mcp).toBe(true);
		expect(c.hooks).toBe(true);
		expect(c.subAgents).toBe(true);
		expect(c.planMode).toBe(true);
		expect(c.reasoningSignature).toBe(true);
		expect(c.cacheUsage).toBe(true);
		expect(c.resume).toBe("native");
	});

	it("availableModels and availableTools return non-empty lists", async () => {
		const { backend } = makeBackend();
		expect((await backend.availableModels()).length).toBeGreaterThan(0);
		expect((await backend.availableTools()).length).toBeGreaterThan(0);
	});
});

describe("ClaudeCodeBackend.sendTurn", () => {
	it("translates a success turn into NormalizedEvent sequence", async () => {
		const record = makeRecord();
		const { backend, runner } = makeBackend(record);
		runner.queueScript([
			{ kind: "system_init", sessionId: "claude-uuid-1", model: "sonnet" },
			{
				kind: "assistant_text_delta",
				delta: "Hello",
				messageId: "m1",
			},
			{ kind: "assistant_text", text: "Hello", messageId: "m1" },
			{
				kind: "result",
				status: "success",
				stopReason: "end_turn",
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		]);
		const events: string[] = [];
		for await (const e of backend.sendTurn({
			sessionId: sessionId("local-1"),
			content: "Hi",
		})) {
			events.push(e.type);
		}
		expect(events).toEqual([
			"assistant.text.delta",
			"assistant.text.done",
			"turn.usage",
			"turn.completed",
		]);
		expect(await backend.hasNativeContext(sessionId("local-1"))).toBe(true);
	});

	it("captures system_init.sessionId into the session map for resume", async () => {
		const record = makeRecord();
		const { backend, runner } = makeBackend(record);
		runner.queueScript([
			{ kind: "system_init", sessionId: "claude-uuid-2" },
			{ kind: "result", status: "success" },
		]);
		for await (const _ of backend.sendTurn({
			sessionId: sessionId("local-1"),
			content: "Hi",
		})) {
			void _;
		}
		// Send a second turn; runner.lastOptions should now carry resumeSessionId.
		runner.queueScript([{ kind: "result", status: "success" }]);
		for await (const _ of backend.sendTurn({
			sessionId: sessionId("local-1"),
			content: "Again",
		})) {
			void _;
		}
		expect(runner.lastOptions?.resumeSessionId).toBe("claude-uuid-2");
	});

	it("translates session_not_found to NormalizedError code", async () => {
		const record = makeRecord();
		const { backend, runner } = makeBackend(record);
		runner.queueScript([
			{
				kind: "result",
				status: "error",
				errors: ["session not found: bad-id"],
			},
		]);
		const collected: import("../backend/types").NormalizedEvent[] = [];
		for await (const e of backend.sendTurn({
			sessionId: sessionId("local-1"),
			content: "Hi",
		})) {
			collected.push(e);
		}
		const failed = collected.find((e) => e.type === "turn.failed");
		expect(failed).toBeTruthy();
		if (failed?.type === "turn.failed") {
			expect(failed.error.code).toBe("session_not_found");
		}
	});

	it("imports legacy SessionMeta.id into the session map on first turn", async () => {
		const record = makeRecord({
			meta: {
				localId: "local-1",
				id: "legacy-claude-uuid",
				title: "Old",
				createdAt: 1,
				updatedAt: 1,
				cwd: "/repo",
			},
			turns: [],
			permissions: { allowedTools: [], deniedTools: [] },
		});
		const { backend, runner } = makeBackend(record);
		runner.queueScript([{ kind: "result", status: "success" }]);
		for await (const _ of backend.sendTurn({
			sessionId: sessionId("local-1"),
			content: "Hi",
		})) {
			void _;
		}
		expect(runner.lastOptions?.resumeSessionId).toBe("legacy-claude-uuid");
	});
});

describe("ClaudeCodeBackend.resolvePermission", () => {
	it("translates allowOnce/allowSession/allowAlways to hook 'allow'", async () => {
		const { backend, hookRespond } = makeBackend(makeRecord());
		await backend.resolvePermission(permReqId("tool_xyz"), "allowOnce");
		await backend.resolvePermission(permReqId("tool_xyz"), "allowSession");
		await backend.resolvePermission(permReqId("tool_xyz"), "allowAlways");
		expect(hookRespond).toHaveBeenCalledTimes(3);
		expect(hookRespond.mock.calls[0]?.[1]).toBe("allow");
		expect(hookRespond.mock.calls[1]?.[1]).toBe("allow");
		expect(hookRespond.mock.calls[2]?.[1]).toBe("allow");
	});

	it("translates deny to hook 'deny'", async () => {
		const { backend, hookRespond } = makeBackend(makeRecord());
		await backend.resolvePermission(permReqId("tool_xyz"), "deny");
		expect(hookRespond.mock.calls[0]?.[1]).toBe("deny");
	});
});

describe("ClaudeCodeBackend session ops", () => {
	it("setCwd updates record + session map; getCwd reflects it", async () => {
		const record = makeRecord();
		const { backend, store } = makeBackend(record);
		await backend.setCwd(sessionId("local-1"), "/new/cwd");
		expect(store.records.get("local-1")?.meta.cwd).toBe("/new/cwd");
		expect(await backend.getCwd(sessionId("local-1"))).toBe("/new/cwd");
	});

	it("setModel persists to record meta", async () => {
		const record = makeRecord();
		const { backend, store } = makeBackend(record);
		await backend.setModel(sessionId("local-1"), "opus");
		expect(store.records.get("local-1")?.meta.model).toBe("opus");
	});

	it("setPlanMode toggles permissionMode in session map", async () => {
		const record = makeRecord();
		const { backend, runner } = makeBackend(record);
		backend.setPlanMode(sessionId("local-1"), true);
		runner.queueScript([{ kind: "result", status: "success" }]);
		for await (const _ of backend.sendTurn({
			sessionId: sessionId("local-1"),
			content: "Hi",
		})) {
			void _;
		}
		expect(runner.lastOptions?.permissionMode).toBe("plan");
	});
});

describe("ClaudeCodeBackend authStatus", () => {
	it("reports signed_in with email when auth ok", async () => {
		const { backend } = makeBackend();
		const status = await backend.authStatus();
		expect(status.state).toBe("signed_in");
		if (status.state === "signed_in") {
			expect(status.account?.email).toBe("user@example.com");
		}
	});
});

describe("ClaudeCodeBackend not-implemented stubs throw with documented messages", () => {
	it("setApiKey rejects (subscription auth only)", async () => {
		const { backend } = makeBackend();
		await expect(backend.setApiKey("k")).rejects.toThrow(/API key/);
	});

	it("addMcpServer points at TODO.md", async () => {
		const { backend } = makeBackend();
		await expect(backend.addMcpServer({ name: "x", transport: "stdio" })).rejects.toThrow(
			/TODO/,
		);
	});

	it("triggerCompaction explains it is internal", async () => {
		const { backend } = makeBackend();
		await expect(backend.triggerCompaction(sessionId("any"))).rejects.toThrow(
			/managed internally/,
		);
	});

	it("verifyReasoningBlock returns true (deferred verification)", () => {
		const { backend } = makeBackend();
		expect(backend.verifyReasoningBlock("blk", "sig")).toBe(true);
	});
});
