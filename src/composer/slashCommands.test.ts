import { describe, expect, it } from "vitest";
import {
	commandNameFromPath,
	detectSlashQuery,
	parseCommandFrontmatter,
	rankCommands,
	SlashCommand,
	stripFrontmatter,
} from "./slashCommands";

describe("parseCommandFrontmatter", () => {
	it("returns empty for content without frontmatter", () => {
		expect(parseCommandFrontmatter("just the body")).toEqual({});
		expect(parseCommandFrontmatter("---\nno-closer-line\n")).toEqual({});
	});

	it("extracts description and argument-hint from a basic block", () => {
		const got = parseCommandFrontmatter("---\ndescription: Review a PR\nargument-hint: <pr-number>\n---\nbody");
		expect(got).toEqual({ description: "Review a PR", argumentHint: "<pr-number>" });
	});

	it("accepts CRLF line endings", () => {
		const got = parseCommandFrontmatter("---\r\ndescription: hello\r\n---\r\nbody");
		expect(got.description).toBe("hello");
	});

	it("strips surrounding quotes from values", () => {
		expect(parseCommandFrontmatter('---\ndescription: "quoted value"\n---').description).toBe("quoted value");
		expect(parseCommandFrontmatter("---\ndescription: 'single quoted'\n---").description).toBe("single quoted");
		expect(parseCommandFrontmatter("---\ndescription: “smart quotes”\n---").description).toBe("smart quotes");
	});

	it("ignores comment lines and empty lines inside frontmatter", () => {
		const got = parseCommandFrontmatter("---\n\n# a comment\ndescription: x\n\n---");
		expect(got.description).toBe("x");
	});

	it("treats argumenthint and argument-hint as the same key", () => {
		expect(parseCommandFrontmatter("---\nargumenthint: <foo>\n---").argumentHint).toBe("<foo>");
	});

	it("ignores keys it doesn't know about", () => {
		const got = parseCommandFrontmatter("---\nallowed-tools: Read\ndescription: a\n---");
		expect(got).toEqual({ description: "a" });
	});

	it("ignores lines with no colon", () => {
		const got = parseCommandFrontmatter("---\nthis is not a key value\ndescription: ok\n---");
		expect(got.description).toBe("ok");
	});
});

describe("stripFrontmatter", () => {
	it("strips the leading frontmatter block", () => {
		expect(stripFrontmatter("---\ndesc: x\n---\nbody here")).toBe("body here");
	});

	it("leaves content without frontmatter unchanged", () => {
		expect(stripFrontmatter("just text")).toBe("just text");
	});

	it("does not strip frontmatter that doesn't start at the very top", () => {
		expect(stripFrontmatter("\n\n---\ndesc: x\n---\nbody")).toBe("\n\n---\ndesc: x\n---\nbody");
	});
});

describe("detectSlashQuery", () => {
	it("detects a slash at the start of the message", () => {
		expect(detectSlashQuery("/rev")).toEqual({ query: "rev", triggerStart: 0 });
	});

	it("detects a slash at the start of a new line", () => {
		expect(detectSlashQuery("first line\n/rev")).toEqual({ query: "rev", triggerStart: "first line\n".length });
	});

	it("returns null when slash is preceded by anything other than newline", () => {
		expect(detectSlashQuery("text /rev")).toBeNull();
		expect(detectSlashQuery("a/b")).toBeNull();
		expect(detectSlashQuery(" /rev")).toBeNull();
	});

	it("returns null when no slash is present", () => {
		expect(detectSlashQuery("")).toBeNull();
		expect(detectSlashQuery("hello world")).toBeNull();
	});

	it("closes the popup once the user types whitespace after the command", () => {
		expect(detectSlashQuery("/rev ")).toBeNull();
		expect(detectSlashQuery("/rev arg")).toBeNull();
	});

	it("allows colon for namespaced commands", () => {
		expect(detectSlashQuery("/git:review")).toEqual({ query: "git:review", triggerStart: 0 });
	});

	it("allows hyphens and underscores", () => {
		expect(detectSlashQuery("/lint_check-pr")).toEqual({ query: "lint_check-pr", triggerStart: 0 });
	});

	it("returns null for /-prefixed paths or regex (any non-name char closes)", () => {
		expect(detectSlashQuery("/usr/bin")).toBeNull();
		expect(detectSlashQuery("/foo.bar")).toBeNull();
	});

	it("returns an empty query for the bare slash so the popup can show all commands", () => {
		expect(detectSlashQuery("/")).toEqual({ query: "", triggerStart: 0 });
	});
});

describe("rankCommands", () => {
	const candidates: SlashCommand[] = [
		{ name: "review", description: "Review the diff", source: "project", path: "review.md" },
		{ name: "git:review", description: "Review a PR", source: "user", path: "git/review.md" },
		{ name: "test", description: "Run tests", source: "project", path: "test.md" },
		{ name: "deploy", description: "Ship the build", source: "user", path: "deploy.md" },
	];

	it("returns input-order candidates when query is empty", () => {
		expect(rankCommands(candidates, "", 10).map((c) => c.name)).toEqual([
			"review", "git:review", "test", "deploy",
		]);
	});

	it("respects the limit", () => {
		expect(rankCommands(candidates, "", 2).length).toBe(2);
	});

	it("prefers prefix matches on the name over substring matches", () => {
		expect(rankCommands(candidates, "rev", 10).map((c) => c.name)).toEqual([
			"review", "git:review",
		]);
	});

	it("falls back to substring match on description", () => {
		expect(rankCommands(candidates, "build", 10).map((c) => c.name)).toEqual(["deploy"]);
	});

	it("excludes candidates that match nothing", () => {
		expect(rankCommands(candidates, "xyzzy", 10)).toEqual([]);
	});

	it("is case-insensitive", () => {
		expect(rankCommands(candidates, "REVIEW", 10).map((c) => c.name)).toContain("review");
	});
});

describe("commandNameFromPath", () => {
	it("strips .md extension", () => {
		expect(commandNameFromPath("review.md")).toBe("review");
	});

	it("uses : as a namespace separator", () => {
		expect(commandNameFromPath("git/review.md")).toBe("git:review");
		expect(commandNameFromPath("a/b/c.md")).toBe("a:b:c");
	});

	it("normalizes Windows-style separators", () => {
		expect(commandNameFromPath("git\\review.md")).toBe("git:review");
	});

	it("strips leading slashes", () => {
		expect(commandNameFromPath("/review.md")).toBe("review");
	});

	it("returns empty for invalid input", () => {
		expect(commandNameFromPath("")).toBe("");
		expect(commandNameFromPath(".md")).toBe("");
	});

	it("is case-insensitive on the .md extension", () => {
		expect(commandNameFromPath("review.MD")).toBe("review");
	});
});
