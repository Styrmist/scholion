import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { SessionRecord, SessionStore } from "./store";
import { PluginSettings } from "../settings";
import { SessionMeta } from "../types";

// `resolvePaths(plugin)` reads from the vault adapter and computes per-OS
// paths. We need only `sessionsDir` for the store, so we mock the resolver to
// point at a per-test tmpdir.

let mockSessionsDir = "/unset";

vi.mock("../providers/claude-code/binary/paths", () => ({
	resolvePaths: () => ({
		sessionsDir: mockSessionsDir,
		// Other fields are not consulted by SessionStore.
		vaultRoot: "/v",
		pluginDir: "/p",
		binDir: "/p/bin",
		configDir: "/p/cfg",
		tmpDir: "/p/tmp",
		binaryPath: "/p/bin/claude",
		hookScriptPath: "/p/hook.sh",
	}),
}));

interface FakePlugin {
	settings: PluginSettings;
	saveSettings: () => Promise<void>;
}

function mkPlugin(): FakePlugin {
	const settings = {
		sessions: [] as SessionMeta[],
	} as PluginSettings;
	return {
		settings,
		saveSettings: () => Promise.resolve(),
	};
}

function mkRecord(localId: string, title = "t"): SessionRecord {
	return {
		meta: {
			localId,
			title,
			createdAt: 1,
			updatedAt: 1,
			cwd: "/v",
		},
		turns: [],
		permissions: { allowedTools: [], deniedTools: [] },
	};
}

describe("SessionStore", () => {
	let dir: string;
	let plugin: FakePlugin;
	let store: SessionStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-store-"));
		mockSessionsDir = dir;
		plugin = mkPlugin();
		store = new SessionStore(plugin as never);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.useRealTimers();
	});

	describe("createMeta", () => {
		it("returns a meta with a non-empty localId and timestamps", () => {
			const meta = store.createMeta("/v");
			expect(meta.localId.length).toBeGreaterThan(0);
			expect(meta.cwd).toBe("/v");
			expect(meta.createdAt).toBeGreaterThan(0);
			expect(meta.createdAt).toBe(meta.updatedAt);
		});

		it("generates unique localIds across rapid calls", () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) ids.add(store.createMeta("/v").localId);
			expect(ids.size).toBe(100);
		});
	});

	describe("saveImmediate / load", () => {
		it("round-trips a record through disk", async () => {
			const r = mkRecord("abc");
			await store.saveImmediate(r);
			const loaded = await store.load("abc");
			expect(loaded).toEqual(r);
		});

		it("upserts the meta into plugin.settings.sessions", async () => {
			const r = mkRecord("abc", "first");
			await store.saveImmediate(r);
			expect(plugin.settings.sessions.map((s) => s.localId)).toEqual(["abc"]);
			r.meta.title = "second";
			await store.saveImmediate(r);
			expect(plugin.settings.sessions).toHaveLength(1);
			expect(plugin.settings.sessions[0]?.title).toBe("second");
		});

		it("writes via .tmp + rename (no orphan tmp on success)", async () => {
			const r = mkRecord("xyz");
			await store.saveImmediate(r);
			const finalPath = join(dir, "xyz.json");
			expect(existsSync(finalPath)).toBe(true);
			expect(existsSync(finalPath + ".tmp")).toBe(false);
			expect(JSON.parse(readFileSync(finalPath, "utf8"))).toEqual(r);
		});

		it("load returns null for a missing record", async () => {
			expect(await store.load("nope")).toBe(null);
		});
	});

	describe("scheduleSave / debounce", () => {
		it("collapses rapid scheduleSave calls into one pending entry; flushAll writes once", async () => {
			const r = mkRecord("dbg");
			store.scheduleSave(r);
			store.scheduleSave(r);
			store.scheduleSave(r);
			// Before flushing, nothing on disk.
			expect(existsSync(join(dir, "dbg.json"))).toBe(false);
			await store.flushAll();
			expect(existsSync(join(dir, "dbg.json"))).toBe(true);
			// And exactly one meta entry, not three.
			expect(plugin.settings.sessions.filter((s) => s.localId === "dbg")).toHaveLength(1);
		});

		it("scheduleSave with the latest record snapshot wins after flush", async () => {
			const r = mkRecord("late", "first");
			store.scheduleSave(r);
			r.meta.title = "second";
			store.scheduleSave(r);
			await store.flushAll();
			const loaded = await store.load("late");
			expect(loaded?.meta.title).toBe("second");
		});
	});

	describe("flushAllSync", () => {
		it("synchronously writes any pending debounced saves", () => {
			const r = mkRecord("fls");
			store.scheduleSave(r);
			expect(existsSync(join(dir, "fls.json"))).toBe(false);
			store.flushAllSync();
			expect(existsSync(join(dir, "fls.json"))).toBe(true);
			expect(plugin.settings.sessions.map((s) => s.localId)).toContain("fls");
		});

		it("is a no-op when there are no pending saves", () => {
			expect(() => store.flushAllSync()).not.toThrow();
		});
	});

	describe("list", () => {
		it("returns sessions sorted by updatedAt descending", () => {
			plugin.settings.sessions = [
				{ localId: "old", title: "", createdAt: 1, updatedAt: 1, cwd: "/" },
				{ localId: "new", title: "", createdAt: 1, updatedAt: 100, cwd: "/" },
				{ localId: "mid", title: "", createdAt: 1, updatedAt: 50, cwd: "/" },
			];
			expect(store.list().map((m) => m.localId)).toEqual(["new", "mid", "old"]);
		});

		it("returns a copy (mutating result does not affect settings)", () => {
			plugin.settings.sessions = [
				{ localId: "a", title: "", createdAt: 1, updatedAt: 1, cwd: "/" },
			];
			const list = store.list();
			list.push({ localId: "b", title: "", createdAt: 1, updatedAt: 1, cwd: "/" });
			expect(plugin.settings.sessions).toHaveLength(1);
		});
	});

	describe("delete", () => {
		it("removes the file and the meta entry", async () => {
			const r = mkRecord("del");
			await store.saveImmediate(r);
			expect(existsSync(join(dir, "del.json"))).toBe(true);
			await store.delete("del");
			expect(existsSync(join(dir, "del.json"))).toBe(false);
			expect(plugin.settings.sessions.find((s) => s.localId === "del")).toBeUndefined();
		});

		it("is safe to call for a record that doesn't exist on disk", async () => {
			plugin.settings.sessions = [
				{ localId: "phantom", title: "", createdAt: 1, updatedAt: 1, cwd: "/" },
			];
			await store.delete("phantom");
			expect(plugin.settings.sessions).toHaveLength(0);
		});
	});

	describe("rename", () => {
		it("updates title + updatedAt and persists", async () => {
			const r = mkRecord("ren", "old");
			await store.saveImmediate(r);
			const before = r.meta.updatedAt;
			await new Promise((r) => setTimeout(r, 5));
			await store.rename("ren", "new");
			const reloaded = await store.load("ren");
			expect(reloaded?.meta.title).toBe("new");
			expect(reloaded!.meta.updatedAt).toBeGreaterThanOrEqual(before);
		});

		it("is a no-op for a missing record", async () => {
			await expect(store.rename("nope", "x")).resolves.toBeUndefined();
		});
	});
});
