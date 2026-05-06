import { describe, expect, it } from "vitest";
import { buildSettingsJson } from "./settingsJson";
import { HOOK_OUTER_TIMEOUT_SEC } from "../../constants";

interface ParsedSettings {
	permissions: { deny: unknown[] };
	permission_mode: string;
	hooks: {
		PreToolUse: Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string; timeout: number }>;
		}>;
	};
}

describe("buildSettingsJson", () => {
	it("produces JSON-parseable output with the expected top-level shape", () => {
		const json = buildSettingsJson({
			permissionMode: "default",
			configDir: "config",
			hookCommand: "/path/to/hook",
		});
		const parsed = JSON.parse(json) as ParsedSettings;
		expect(parsed.permissions).toBeDefined();
		expect(Array.isArray(parsed.permissions.deny)).toBe(true);
		expect(parsed.permission_mode).toBe("default");
		expect(parsed.hooks.PreToolUse).toHaveLength(1);
	});

	it("uses '*' as the hook matcher (every tool)", () => {
		const parsed = JSON.parse(buildSettingsJson({
			permissionMode: "default",
			configDir: "c",
			hookCommand: "h",
		})) as ParsedSettings;
		expect(parsed.hooks.PreToolUse[0]?.matcher).toBe("*");
	});

	it("defaults the hook timeout to HOOK_OUTER_TIMEOUT_SEC", () => {
		const parsed = JSON.parse(buildSettingsJson({
			permissionMode: "default",
			configDir: "c",
			hookCommand: "h",
		})) as ParsedSettings;
		expect(parsed.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(HOOK_OUTER_TIMEOUT_SEC);
	});

	it("respects an explicit hookTimeoutSec override", () => {
		const parsed = JSON.parse(buildSettingsJson({
			permissionMode: "plan",
			configDir: "c",
			hookCommand: "h",
			hookTimeoutSec: 42,
		})) as ParsedSettings;
		expect(parsed.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(42);
	});

	it("threads the hookCommand through to hooks[0].command", () => {
		const parsed = JSON.parse(buildSettingsJson({
			permissionMode: "default",
			configDir: "c",
			hookCommand: "powershell.exe -File /x",
		})) as ParsedSettings;
		expect(parsed.hooks.PreToolUse[0]?.hooks[0]?.type).toBe("command");
		expect(parsed.hooks.PreToolUse[0]?.hooks[0]?.command).toBe("powershell.exe -File /x");
	});

	it("threads permissionMode through unchanged", () => {
		const parsed = JSON.parse(buildSettingsJson({
			permissionMode: "acceptEdits",
			configDir: "c",
			hookCommand: "h",
		})) as ParsedSettings;
		expect(parsed.permission_mode).toBe("acceptEdits");
	});

	it("includes deny rules generated from buildSafetyDenyRules for the configDir", () => {
		const parsed = JSON.parse(buildSettingsJson({
			permissionMode: "default",
			configDir: ".obsidian/plugins/cc/config",
			hookCommand: "h",
		})) as ParsedSettings;
		// Three protected paths (Read/Edit/Write) plus the Bash command pattern.
		expect(parsed.permissions.deny.length).toBeGreaterThanOrEqual(4);
		const json = JSON.stringify(parsed.permissions.deny);
		expect(json).toContain(".obsidian/plugins/cc/config");
	});
});
