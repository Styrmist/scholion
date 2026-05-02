import { describe, expect, it } from "vitest";
import { buildArgs } from "./runner";
import { SendOptions } from "../types";

function mkOpts(overrides: Partial<SendOptions> = {}): SendOptions {
	return {
		prompt: "hello",
		cwd: "/vault",
		binaryPath: "/bin/claude",
		configDir: "/cfg",
		permissionMode: "default",
		settingsJson: "{}",
		signal: new AbortController().signal,
		onEvent: () => undefined,
		...overrides,
	};
}

describe("buildArgs", () => {
	it("includes the required flags in stable order", () => {
		const args = buildArgs(mkOpts({ prompt: "hi" }));
		expect(args).toEqual([
			"-p",
			"hi",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--include-hook-events",
			"--settings",
			"{}",
		]);
	});

	it("appends --resume <id> when resumeSessionId is set", () => {
		const args = buildArgs(mkOpts({ resumeSessionId: "sess-1" }));
		expect(args).toContain("--resume");
		expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
	});

	it("omits --resume when resumeSessionId is empty/undefined", () => {
		const args = buildArgs(mkOpts({ resumeSessionId: "" }));
		expect(args).not.toContain("--resume");
	});

	it("appends --model <name> when model is set", () => {
		const args = buildArgs(mkOpts({ model: "opus" }));
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("opus");
	});

	it("omits --model when model is undefined", () => {
		const args = buildArgs(mkOpts());
		expect(args).not.toContain("--model");
	});

	it("appends --append-system-prompt when systemPromptAddendum is set and non-blank", () => {
		const args = buildArgs(mkOpts({ systemPromptAddendum: "be helpful" }));
		expect(args).toContain("--append-system-prompt");
		expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("be helpful");
	});

	it("omits --append-system-prompt for whitespace-only addendum", () => {
		const args = buildArgs(mkOpts({ systemPromptAddendum: "   " }));
		expect(args).not.toContain("--append-system-prompt");
	});

	it("never includes --allowedTools (permissions go via PreToolUse hook)", () => {
		const args = buildArgs(mkOpts({ resumeSessionId: "x", model: "opus", systemPromptAddendum: "y" }));
		expect(args).not.toContain("--allowedTools");
		expect(args).not.toContain("--allowed-tools");
		expect(args).not.toContain("--allow-tools");
	});

	it("passes through the settingsJson string verbatim after --settings", () => {
		const json = '{"permissions":{}}';
		const args = buildArgs(mkOpts({ settingsJson: json }));
		const idx = args.indexOf("--settings");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe(json);
	});
});
