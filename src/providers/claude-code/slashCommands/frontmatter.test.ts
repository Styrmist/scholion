import { describe, expect, it } from "vitest";
import {
	BUILTIN_COMMANDS,
	commandNameFromPath,
	detectSlashQuery,
	isKnownSlashCommandInvocation,
	mergeWithBuiltins,
	parseCommandFrontmatter,
	rankCommands,
	SlashCommand,
	stripFrontmatter,
} from "./frontmatter";

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

describe("BUILTIN_COMMANDS", () => {
	it("contains the curated set verified empirically against the bundled CLI", () => {
		const names = BUILTIN_COMMANDS.map((c) => c.name).sort();
		expect(names).toEqual(["clear", "compact", "cost", "init", "review"]);
	});

	it("flags every entry as source: builtin", () => {
		for (const cmd of BUILTIN_COMMANDS) {
			expect(cmd.source).toBe("builtin");
			expect(cmd.description).toBeTruthy();
		}
	});

	it("does not include 'isn't available in this environment' commands", () => {
		const names = new Set(BUILTIN_COMMANDS.map((c) => c.name));
		for (const interactiveOnly of ["model", "agents", "skills", "settings", "login", "plugin", "mcp", "bug", "permissions", "exit", "quit", "doctor", "status", "memory"]) {
			expect(names.has(interactiveOnly)).toBe(false);
		}
	});
});

describe("mergeWithBuiltins", () => {
	const fsProject: SlashCommand = { name: "review", source: "project", path: "review.md", description: "project version" };
	const fsUser: SlashCommand = { name: "deploy", source: "user", path: "deploy.md" };
	const builtin: SlashCommand = { name: "cost", source: "builtin", path: "<builtin>", description: "show cost" };

	it("appends built-ins after filesystem commands when names don't collide", () => {
		const got = mergeWithBuiltins([fsUser], [builtin]);
		expect(got.map((c) => c.name)).toEqual(["deploy", "cost"]);
	});

	it("filesystem command shadows a built-in of the same name", () => {
		const got = mergeWithBuiltins([fsProject], [{ name: "review", source: "builtin", path: "<builtin>" }]);
		expect(got.length).toBe(1);
		expect(got[0]!.source).toBe("project");
		expect(got[0]!.description).toBe("project version");
	});

	it("preserves the filesystem ordering verbatim", () => {
		const fs: SlashCommand[] = [
			{ name: "z", source: "project", path: "z.md" },
			{ name: "a", source: "user", path: "a.md" },
		];
		const got = mergeWithBuiltins(fs, []);
		expect(got.map((c) => c.name)).toEqual(["z", "a"]);
	});

	it("preserves the built-in declared order at the tail", () => {
		const builtins: SlashCommand[] = [
			{ name: "alpha", source: "builtin", path: "<builtin>" },
			{ name: "beta", source: "builtin", path: "<builtin>" },
			{ name: "gamma", source: "builtin", path: "<builtin>" },
		];
		const got = mergeWithBuiltins([], builtins);
		expect(got.map((c) => c.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("dedups within the built-in list itself (defensive — should never happen but guards against regressions)", () => {
		const dupes: SlashCommand[] = [
			{ name: "x", source: "builtin", path: "<builtin>", description: "first" },
			{ name: "x", source: "builtin", path: "<builtin>", description: "second" },
		];
		const got = mergeWithBuiltins([], dupes);
		expect(got.length).toBe(1);
		expect(got[0]!.description).toBe("first");
	});

	it("uses BUILTIN_COMMANDS by default when no second arg is given", () => {
		const got = mergeWithBuiltins([]);
		expect(got.map((c) => c.name)).toEqual(BUILTIN_COMMANDS.map((c) => c.name));
	});

	it("returns an empty list for an empty fs list and empty builtins arg", () => {
		expect(mergeWithBuiltins([], [])).toEqual([]);
	});
});

describe("isKnownSlashCommandInvocation", () => {
	const known = new Set(["cost", "compact", "review", "git:fixup"]);

	it("returns the command name when text starts with /<known>", () => {
		expect(isKnownSlashCommandInvocation("/cost", known)).toBe("cost");
		expect(isKnownSlashCommandInvocation("/compact", known)).toBe("compact");
	});

	it("returns the command name when /<known> is followed by arguments", () => {
		expect(isKnownSlashCommandInvocation("/review HEAD~3", known)).toBe("review");
		expect(isKnownSlashCommandInvocation("/cost --details", known)).toBe("cost");
	});

	it("supports namespaced command names with colon", () => {
		expect(isKnownSlashCommandInvocation("/git:fixup abc123", known)).toBe("git:fixup");
	});

	it("returns null for unknown commands", () => {
		expect(isKnownSlashCommandInvocation("/randmm", known)).toBeNull();
		expect(isKnownSlashCommandInvocation("/typo with args", known)).toBeNull();
	});

	it("returns null when the slash isn't at the start of the message", () => {
		expect(isKnownSlashCommandInvocation(" /cost", known)).toBeNull();
		expect(isKnownSlashCommandInvocation("hi /cost", known)).toBeNull();
	});

	it("returns null when there's no name after the slash", () => {
		expect(isKnownSlashCommandInvocation("/", known)).toBeNull();
		expect(isKnownSlashCommandInvocation("/ cost", known)).toBeNull();
	});

	it("returns null when the slash is followed by punctuation", () => {
		expect(isKnownSlashCommandInvocation("/!cost", known)).toBeNull();
		expect(isKnownSlashCommandInvocation("/.cost", known)).toBeNull();
	});

	it("does not match when the name has extra letters not in known", () => {
		expect(isKnownSlashCommandInvocation("/costabc", known)).toBeNull();
		expect(isKnownSlashCommandInvocation("/costx args", known)).toBeNull();
	});

	it("returns null for an empty known-set even on valid syntax", () => {
		expect(isKnownSlashCommandInvocation("/cost", new Set())).toBeNull();
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
