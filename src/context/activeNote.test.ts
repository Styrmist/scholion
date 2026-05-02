import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { isMarkdownLike, truncate } from "./activeNote";
import { hashString } from "../utils/fs";

describe("isMarkdownLike", () => {
	function file(ext: string): TFile {
		const f = new TFile();
		f.extension = ext;
		return f;
	}

	it("accepts md / markdown / txt", () => {
		expect(isMarkdownLike(file("md"))).toBe(true);
		expect(isMarkdownLike(file("markdown"))).toBe(true);
		expect(isMarkdownLike(file("txt"))).toBe(true);
	});

	it("rejects other extensions", () => {
		expect(isMarkdownLike(file("json"))).toBe(false);
		expect(isMarkdownLike(file("png"))).toBe(false);
		expect(isMarkdownLike(file(""))).toBe(false);
	});

	it("is case-sensitive (matches Obsidian's TFile.extension which is lowercased)", () => {
		// .extension is conventionally lowercase in Obsidian; the helper does
		// not lowercase, so an upper-case input would not match.
		expect(isMarkdownLike(file("MD"))).toBe(false);
	});
});

describe("truncate", () => {
	it("returns the input unchanged when under the byte budget", () => {
		const out = truncate("hello", 1);
		expect(out.content).toBe("hello");
		expect(out.bytes).toBe(5);
		expect(out.truncated).toBeUndefined();
	});

	it("clamps to maxKB * 1024 bytes when exceeded", () => {
		const big = "x".repeat(5000);
		const out = truncate(big, 1); // 1 KB = 1024 bytes
		expect(out.bytes).toBe(1024);
		expect(out.content.length).toBe(1024);
		expect(out.truncated).toEqual({ originalBytes: 5000 });
	});

	it("never returns more than the budget for ASCII input", () => {
		const out = truncate("y".repeat(10_000), 4);
		expect(Buffer.from(out.content, "utf8").length).toBeLessThanOrEqual(4 * 1024);
	});

	it("does not split a multi-byte UTF-8 sequence (boundary safe)", () => {
		// Build a string of 2-byte chars filling exactly 1 byte over the budget.
		const oneKb = 1024;
		// '€' is 3 bytes in UTF-8.
		const piece = "€";
		const big = piece.repeat(500); // 1500 bytes
		const out = truncate(big, 1);
		// Decoder-safe: the resulting string round-trips cleanly back to UTF-8
		// without a U+FFFD (replacement char) tail. We also accept that bytes
		// reported is the *budget*, not the actual decoded length.
		expect(out.content).not.toMatch(/�$/);
		// Budget is reported, not the actual UTF-8 length of the decoded slice.
		expect(out.bytes).toBe(oneKb);
		expect(out.truncated).toEqual({ originalBytes: 1500 });
	});

	it("handles maxKB <= 0 by clamping to 1KB minimum", () => {
		const big = "z".repeat(5000);
		const out0 = truncate(big, 0);
		const outNeg = truncate(big, -3);
		expect(out0.bytes).toBe(1024);
		expect(outNeg.bytes).toBe(1024);
	});

	it("treats fractional maxKB by floor (1.9 → 1KB)", () => {
		const big = "a".repeat(5000);
		const out = truncate(big, 1.9);
		expect(out.bytes).toBe(1024);
	});
});

describe("hashString determinism (sanity check for context hash inputs)", () => {
	it("same input → same digest", () => {
		const a = hashString("note:p:hello");
		const b = hashString("note:p:hello");
		expect(a).toBe(b);
	});

	it("different inputs → different digests", () => {
		expect(hashString("note:p:a")).not.toBe(hashString("note:p:b"));
	});

	it("path or content change yields a different hash", () => {
		expect(hashString("note:a:body")).not.toBe(hashString("note:b:body"));
		expect(hashString("note:a:b1")).not.toBe(hashString("note:a:b2"));
	});
});
