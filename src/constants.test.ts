import { describe, expect, it } from "vitest";
import { buildSafetyDenyRules, escapeGlobMetaChars } from "./constants";

describe("escapeGlobMetaChars", () => {
	it("returns the input unchanged when no meta chars present", () => {
		expect(escapeGlobMetaChars("/a/b/c")).toBe("/a/b/c");
		expect(escapeGlobMetaChars("plain.text")).toBe("plain.text");
	});

	it("returns empty for empty input", () => {
		expect(escapeGlobMetaChars("")).toBe("");
	});

	it("wraps each glob meta char in a character class", () => {
		expect(escapeGlobMetaChars("a*b")).toBe("a[*]b");
		expect(escapeGlobMetaChars("a?b")).toBe("a[?]b");
		expect(escapeGlobMetaChars("a[b]c")).toBe("a[[]b[]]c");
		expect(escapeGlobMetaChars("a\\b")).toBe("a[\\]b");
	});

	it("handles multiple meta chars in one string", () => {
		expect(escapeGlobMetaChars("a*b?c")).toBe("a[*]b[?]c");
	});

	it("handles only-meta-char input", () => {
		expect(escapeGlobMetaChars("*")).toBe("[*]");
		expect(escapeGlobMetaChars("?")).toBe("[?]");
	});
});

describe("buildSafetyDenyRules", () => {
	it("emits 4 rules: Read/Edit/Write paths plus Bash command", () => {
		const rules = buildSafetyDenyRules("config");
		expect(rules).toHaveLength(4);
		const tools = rules.map((r) => r.tool);
		expect(tools).toEqual(["Read", "Edit", "Write", "Bash"]);
	});

	it("uses the same configDir verbatim in all path rules when no meta chars", () => {
		const rules = buildSafetyDenyRules(".obsidian/plugins/cc/config");
		expect(rules[0]).toEqual({ tool: "Read", path: "./.obsidian/plugins/cc/config/**" });
		expect(rules[1]).toEqual({ tool: "Edit", path: "./.obsidian/plugins/cc/config/**" });
		expect(rules[2]).toEqual({ tool: "Write", path: "./.obsidian/plugins/cc/config/**" });
		expect(rules[3]).toEqual({ tool: "Bash", command: "*.obsidian/plugins/cc/config*" });
	});

	it("escapes glob meta chars in the configDir so the rule matches literally", () => {
		const rules = buildSafetyDenyRules("v[1]/c*fg");
		const readRule = rules[0] as { path: string };
		expect(readRule.path).toBe("./v[[]1[]]/c[*]fg/**");
		const bashRule = rules[3] as { command: string };
		expect(bashRule.command).toBe("*v[[]1[]]/c[*]fg*");
	});

	it("normalizes Windows backslashes to forward slashes before escaping", () => {
		const rules = buildSafetyDenyRules("C:\\Users\\me\\config");
		const readRule = rules[0] as { path: string };
		// Backslashes converted to slashes; no `\` left to glob-escape.
		expect(readRule.path).toBe("./C:/Users/me/config/**");
	});
});
