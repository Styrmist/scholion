import { describe, expect, it } from "vitest";
import { BackendRegistry } from "./registry";
import type { Backend, Capabilities } from "./types";
import type { BackendId } from "./ids";

const baseCaps: Capabilities = {
	agentic: false,
	attachments: { image: false, file: false },
	resume: "replay",
	reasoning: false,
	reasoningSignature: false,
	mcp: false,
	slashCommands: false,
	hooks: false,
	subAgents: false,
	planMode: false,
	compaction: false,
	citations: false,
	cacheUsage: false,
	costTracking: false,
};

const stubBackend = (id: BackendId): Backend => ({
	id: () => id,
	capabilities: () => baseCaps,
	availableModels: async () => [],
	isAvailable: async () => true,
	version: async () => "0.0.0",
	authStatus: async () => ({ state: "signed_out" }) as const,
	createSession: async () => ({ id: "s" as never, backendId: id }),
	listSessions: async () => [],
	getSession: async () => ({}) as never,
	renameSession: async () => undefined,
	deleteSession: async () => undefined,
	sendTurn: () => ({
		[Symbol.asyncIterator]: () => ({
			next: async () => ({ value: undefined, done: true }),
		}),
	}),
	abortTurn: async () => undefined,
	setModel: async () => undefined,
	diagnostics: () => ({
		[Symbol.asyncIterator]: () => ({
			next: async () => ({ value: undefined, done: true }),
		}),
	}),
	hasNativeContext: async () => false,
	getNativeAdapter: () => ({}),
});

describe("BackendRegistry", () => {
	it("registers and retrieves a backend by id", () => {
		const r = new BackendRegistry();
		const b = stubBackend("claude-code");
		r.register(b);
		expect(r.get("claude-code")).toBe(b);
		expect(r.has("claude-code")).toBe(true);
		expect(r.list()).toEqual([b]);
	});

	it("rejects duplicate registration of the same id", () => {
		const r = new BackendRegistry();
		r.register(stubBackend("claude-code"));
		expect(() => r.register(stubBackend("claude-code"))).toThrow(
			/already registered/,
		);
	});

	it("get throws for an unregistered id", () => {
		const r = new BackendRegistry();
		expect(() => r.get("codex")).toThrow(/not registered/);
	});

	it("tryGet returns undefined for an unregistered id", () => {
		const r = new BackendRegistry();
		expect(r.tryGet("codex")).toBeUndefined();
	});

	it("first registered backend becomes the default", () => {
		const r = new BackendRegistry();
		const a = stubBackend("claude-code");
		const b = stubBackend("codex");
		r.register(a);
		r.register(b);
		expect(r.default()).toBe(a);
	});

	it("setDefault switches to a registered id", () => {
		const r = new BackendRegistry();
		r.register(stubBackend("claude-code"));
		r.register(stubBackend("codex"));
		r.setDefault("codex");
		expect(r.default().id()).toBe("codex");
	});

	it("setDefault throws for an unregistered id", () => {
		const r = new BackendRegistry();
		r.register(stubBackend("claude-code"));
		expect(() => r.setDefault("codex")).toThrow(/unregistered backend/);
	});

	it("default throws when nothing is registered", () => {
		const r = new BackendRegistry();
		expect(() => r.default()).toThrow(/No backend registered/);
	});
});
