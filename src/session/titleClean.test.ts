import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, heuristicTitle, stripNoise, trimPunctNoise } from "./titleClean";

describe("stripNoise", () => {
	it("collapses [label](url) to label", () => {
		expect(stripNoise("read [SwiftUI tutorial](https://x.com/100) tonight")).toBe("read SwiftUI tutorial tonight");
	});

	it("removes bare URLs", () => {
		expect(stripNoise("see https://example.com/path now")).toBe("see now");
	});

	it("removes lingering bare http/https tokens (mid-string ellipsis stays)", () => {
		expect(stripNoise("foo https ww… bar")).toBe("foo ww… bar");
	});

	it("trims trailing ellipsis after a bare http/https token strip", () => {
		expect(stripNoise("foo bar https ww…")).toBe("foo bar ww");
	});

	it("trims trailing punctuation/parens/quotes/ellipsis runs", () => {
		expect(stripNoise("...hello world!!!")).toBe("hello world");
		expect(stripNoise('"a quoted thing"')).toBe("a quoted thing");
	});

	it("collapses internal whitespace runs", () => {
		expect(stripNoise("a   b\t\tc")).toBe("a b c");
	});

	it("returns empty when input is whitespace/punctuation only", () => {
		expect(stripNoise("")).toBe("");
		expect(stripNoise("   ")).toBe("");
		expect(stripNoise("...")).toBe("");
	});
});

describe("trimPunctNoise", () => {
	it("strips leading/trailing punctuation/quotes only", () => {
		expect(trimPunctNoise("...hello...")).toBe("hello");
		expect(trimPunctNoise("--- title ---")).toBe("title");
		expect(trimPunctNoise("(question)")).toBe("question");
	});

	it("leaves the body unchanged", () => {
		expect(trimPunctNoise("a-b/c:d")).toBe("a-b/c:d");
	});
});

describe("heuristicTitle", () => {
	it("returns the cleaned message under 60 chars verbatim", () => {
		expect(heuristicTitle("How do I install Rust?")).toBe("How do I install Rust");
	});

	it("strips Markdown link syntax to the visible label", () => {
		expect(heuristicTitle("read [the docs](https://example.com)")).toBe("read the docs");
	});

	it("strips a pasted URL entirely", () => {
		expect(heuristicTitle("https://www.example.com/very/long/path")).toBe("New chat");
	});

	it("falls back to 'New chat' when cleaning eats the message", () => {
		expect(heuristicTitle("")).toBe("New chat");
		expect(heuristicTitle("...??...")).toBe("New chat");
	});

	it("caps at 60 chars with a trailing ellipsis when the message is long", () => {
		const long = "How do I implement a reactive store with computed signals across nested namespaces in TypeScript?";
		const got = heuristicTitle(long);
		expect(got.length).toBeLessThanOrEqual(60);
		expect(got.endsWith("…")).toBe(true);
	});

	it("collapses newlines/tabs into single spaces", () => {
		expect(heuristicTitle("line one\n\nline two\n\tline three")).toBe("line one line two line three");
	});
});

describe("cleanGeneratedTitle", () => {
	it("returns the title when it's already clean", () => {
		expect(cleanGeneratedTitle("Installing Rust on macOS")).toBe("Installing Rust on macOS");
	});

	it("strips paired straight quotes", () => {
		expect(cleanGeneratedTitle('"Installing Rust"')).toBe("Installing Rust");
		expect(cleanGeneratedTitle("'Installing Rust'")).toBe("Installing Rust");
	});

	it("strips paired curly quotes (smart quotes Claude sometimes uses)", () => {
		expect(cleanGeneratedTitle("“Installing Rust”")).toBe("Installing Rust");
		expect(cleanGeneratedTitle("‘Installing Rust’")).toBe("Installing Rust");
	});

	it("strips a trailing period or ellipsis", () => {
		expect(cleanGeneratedTitle("Installing Rust.")).toBe("Installing Rust");
		expect(cleanGeneratedTitle("Installing Rust…")).toBe("Installing Rust");
	});

	it("collapses whitespace runs and trims", () => {
		expect(cleanGeneratedTitle("  Installing   Rust   ")).toBe("Installing Rust");
	});

	it("returns empty when cleaning leaves nothing usable", () => {
		expect(cleanGeneratedTitle("")).toBe("");
		expect(cleanGeneratedTitle("...")).toBe("");
		expect(cleanGeneratedTitle('""')).toBe("");
	});

	it("caps at 60 chars with ellipsis", () => {
		const long = "x".repeat(70);
		const got = cleanGeneratedTitle(long);
		expect(got.length).toBe(58);
		expect(got.endsWith("…")).toBe(true);
	});
});
