import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicWriteJson,
	ensureDir,
	hashString,
	readJsonIfExists,
} from "./fs";

describe("hashString", () => {
	it("matches the canonical SHA-256 of the empty string", () => {
		expect(hashString("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("matches the canonical SHA-256 of 'abc'", () => {
		expect(hashString("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is deterministic across calls", () => {
		expect(hashString("hello")).toBe(hashString("hello"));
	});

	it("differs for different inputs", () => {
		expect(hashString("a")).not.toBe(hashString("b"));
	});
});

describe("ensureDir", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-fs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates a missing directory", () => {
		const target = join(dir, "a", "b", "c");
		expect(existsSync(target)).toBe(false);
		ensureDir(target);
		expect(existsSync(target)).toBe(true);
	});

	it("is idempotent on an existing directory", () => {
		ensureDir(dir);
		ensureDir(dir);
		expect(existsSync(dir)).toBe(true);
	});
});

describe("readJsonIfExists", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-fs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when the file does not exist", async () => {
		expect(await readJsonIfExists(join(dir, "missing.json"))).toBe(null);
	});

	it("returns the parsed object for a valid JSON file", async () => {
		const path = join(dir, "ok.json");
		writeFileSync(path, JSON.stringify({ a: 1, b: [2, 3] }));
		expect(await readJsonIfExists(path)).toEqual({ a: 1, b: [2, 3] });
	});

	it("rethrows non-ENOENT errors (e.g. malformed JSON)", async () => {
		const path = join(dir, "bad.json");
		writeFileSync(path, "{ not json");
		await expect(readJsonIfExists(path)).rejects.toThrow();
	});
});

describe("atomicWriteJson", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-fs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a parseable JSON file", async () => {
		const path = join(dir, "x.json");
		await atomicWriteJson(path, { hello: "world" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hello: "world" });
	});

	it("creates parent directories as needed", async () => {
		const path = join(dir, "a", "b", "x.json");
		await atomicWriteJson(path, { ok: true });
		expect(existsSync(path)).toBe(true);
	});

	it("does not leave a .tmp file on success", async () => {
		const path = join(dir, "no-leak.json");
		await atomicWriteJson(path, { ok: true });
		expect(existsSync(path + ".tmp")).toBe(false);
	});

	it("overwrites an existing file (rename is replace-on-existing)", async () => {
		const path = join(dir, "over.json");
		await atomicWriteJson(path, { v: 1 });
		await atomicWriteJson(path, { v: 2 });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 2 });
	});
});
