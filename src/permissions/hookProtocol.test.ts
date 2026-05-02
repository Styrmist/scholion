import { describe, expect, it } from "vitest";
import {
	isReqFile,
	reqFileName,
	respFileName,
	toolUseIdFromReqFile,
} from "./hookProtocol";

describe("reqFileName / respFileName", () => {
	it("uses 'hook-<id>.req' / 'hook-<id>.resp'", () => {
		expect(reqFileName("abc")).toBe("hook-abc.req");
		expect(respFileName("abc")).toBe("hook-abc.resp");
	});

	it("preserves UUID-like ids with dashes", () => {
		const id = "550e8400-e29b-41d4-a716-446655440000";
		expect(reqFileName(id)).toBe(`hook-${id}.req`);
		expect(respFileName(id)).toBe(`hook-${id}.resp`);
	});

	it("round-trips through toolUseIdFromReqFile", () => {
		const id = "tu_01ABCDEF1234";
		expect(toolUseIdFromReqFile(reqFileName(id))).toBe(id);
	});
});

describe("isReqFile", () => {
	it("matches the exact request format", () => {
		expect(isReqFile("hook-abc.req")).toBe(true);
		expect(isReqFile("hook-tu_01.req")).toBe(true);
	});

	it("rejects response files", () => {
		expect(isReqFile("hook-abc.resp")).toBe(false);
	});

	it("rejects partial/temp files (no .req suffix)", () => {
		expect(isReqFile("hook-abc.req.tmp")).toBe(false);
		expect(isReqFile("hook-abc.tmp")).toBe(false);
	});

	it("rejects unrelated names", () => {
		expect(isReqFile("note.txt")).toBe(false);
		expect(isReqFile("")).toBe(false);
		expect(isReqFile("hook-")).toBe(false);
		expect(isReqFile(".req")).toBe(false);
	});

	it("rejects mismatched prefix even with .req", () => {
		expect(isReqFile("nothook-x.req")).toBe(false);
		expect(isReqFile("xhook-x.req")).toBe(false);
	});
});

describe("toolUseIdFromReqFile", () => {
	it("returns null for a non-request filename", () => {
		expect(toolUseIdFromReqFile("hook-x.resp")).toBe(null);
		expect(toolUseIdFromReqFile("random")).toBe(null);
		expect(toolUseIdFromReqFile("")).toBe(null);
	});

	it("extracts the id between prefix and suffix", () => {
		expect(toolUseIdFromReqFile("hook-tu_abc.req")).toBe("tu_abc");
	});

	it("preserves dashes inside the id", () => {
		expect(toolUseIdFromReqFile("hook-a-b-c.req")).toBe("a-b-c");
	});
});
