import { describe, expect, it } from "vitest";
import { buildArgs, shouldSendPromptViaStdin } from "./runner";
import { PROMPT_VIA_STDIN_THRESHOLD_BYTES } from "../../constants";
import { SendOptions } from "../../types";

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

	it("omits the positional prompt when promptViaStdin is true (CLI reads stdin instead)", () => {
		const args = buildArgs(mkOpts({ prompt: "long-prompt-goes-here" }), { promptViaStdin: true });
		expect(args[0]).toBe("-p");
		expect(args).not.toContain("long-prompt-goes-here");
		expect(args[1]).toBe("--output-format");
	});

	it("still passes resume/model flags when promptViaStdin is true", () => {
		const args = buildArgs(
			mkOpts({ prompt: "x", resumeSessionId: "sess-9", model: "opus" }),
			{ promptViaStdin: true },
		);
		expect(args).toContain("--resume");
		expect(args[args.indexOf("--resume") + 1]).toBe("sess-9");
		expect(args).toContain("--model");
	});
});

describe("shouldSendPromptViaStdin", () => {
	it("never triggers on darwin or linux regardless of size", () => {
		expect(shouldSendPromptViaStdin(0, "darwin")).toBe(false);
		expect(shouldSendPromptViaStdin(1_000_000, "darwin")).toBe(false);
		expect(shouldSendPromptViaStdin(1_000_000, "linux")).toBe(false);
	});

	it("does not trigger on win32 below the threshold", () => {
		expect(shouldSendPromptViaStdin(0, "win32")).toBe(false);
		expect(shouldSendPromptViaStdin(PROMPT_VIA_STDIN_THRESHOLD_BYTES, "win32")).toBe(false);
	});

	it("triggers on win32 above the threshold", () => {
		expect(shouldSendPromptViaStdin(PROMPT_VIA_STDIN_THRESHOLD_BYTES + 1, "win32")).toBe(true);
		expect(shouldSendPromptViaStdin(PROMPT_VIA_STDIN_THRESHOLD_BYTES * 4, "win32")).toBe(true);
	});

	it("threshold is 20 KiB so non-ASCII prompts still fit under Windows' ~32K UTF-16 cap", () => {
		expect(PROMPT_VIA_STDIN_THRESHOLD_BYTES).toBe(20 * 1024);
	});
});
