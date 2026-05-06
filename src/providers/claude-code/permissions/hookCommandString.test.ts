import { describe, expect, it } from "vitest";
import { buildHookCommandFor, quote } from "./hookCommandString";

describe("quote", () => {
	it("wraps simple input in double quotes", () => {
		expect(quote("/usr/local/bin/hook")).toBe('"/usr/local/bin/hook"');
	});

	it("escapes embedded double quotes", () => {
		expect(quote('/path/to/"weird"/file')).toBe('"/path/to/\\"weird\\"/file"');
	});

	it("preserves spaces inside the quoted string", () => {
		expect(quote("/Users/me/Vault With Spaces/hook.sh")).toBe(
			'"/Users/me/Vault With Spaces/hook.sh"',
		);
	});

	it("returns just empty quotes for empty input", () => {
		expect(quote("")).toBe('""');
	});
});

describe("buildHookCommandFor", () => {
	it("Unix: returns the quoted script path on its own", () => {
		expect(buildHookCommandFor("darwin", "/x/permissionHook.sh")).toBe('"/x/permissionHook.sh"');
		expect(buildHookCommandFor("linux", "/x/permissionHook.sh")).toBe('"/x/permissionHook.sh"');
	});

	it("Windows: wraps in PowerShell with -NoProfile -ExecutionPolicy Bypass -File", () => {
		const cmd = buildHookCommandFor("win32", "C:\\path\\hook.ps1");
		expect(cmd).toBe(
			'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\path\\hook.ps1"',
		);
	});

	it("Windows: preserves UNC paths via the same quoting pass", () => {
		const cmd = buildHookCommandFor("win32", "\\\\server\\share\\hook.ps1");
		expect(cmd).toContain('-File "\\\\server\\share\\hook.ps1"');
	});

	it("Unix: handles a path with spaces", () => {
		expect(buildHookCommandFor("darwin", "/Users/x y/hook.sh")).toBe('"/Users/x y/hook.sh"');
	});

	it("escapes embedded double quotes on either platform", () => {
		expect(buildHookCommandFor("darwin", '/x/"odd".sh')).toBe('"/x/\\"odd\\".sh"');
		expect(buildHookCommandFor("win32", 'C:\\x\\"odd".ps1')).toContain('"C:\\x\\\\"odd\\".ps1"');
	});
});
