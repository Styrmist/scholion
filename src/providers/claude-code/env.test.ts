import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIsolatedEnv } from "./env";
import { HOOK_INNER_TIMEOUT_MS } from "../../constants";

const OPTS = { configDir: "/cfg", tmpDir: "/tmp" } as const;

describe("buildIsolatedEnv", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// Wipe to a known baseline so process.env from the test runner doesn't
		// leak unrelated CLAUDE_CODE_*/ANTHROPIC_* vars into expectations.
		for (const k of Object.keys(process.env)) delete process.env[k];
		process.env.PATH = "/usr/bin";
		process.env.HOME = "/home/u";
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, originalEnv);
	});

	it("strips ANTHROPIC_* prefix", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test";
		process.env.ANTHROPIC_BASE_URL = "https://evil";
		const env = buildIsolatedEnv(OPTS);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
	});

	it("strips CLAUDE_CODE_OAUTH_*, _SKIP_*, _CLIENT_*, _CERT_* prefixes", () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "x";
		process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = "1";
		process.env.CLAUDE_CODE_CLIENT_CERT = "x";
		process.env.CLAUDE_CODE_CERT_STORE = "x";
		const env = buildIsolatedEnv(OPTS);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBeUndefined();
		expect(env.CLAUDE_CODE_CLIENT_CERT).toBeUndefined();
		expect(env.CLAUDE_CODE_CERT_STORE).toBeUndefined();
	});

	it("strips cloud provider credential prefixes", () => {
		process.env.AWS_ACCESS_KEY_ID = "x";
		process.env.AZURE_CLIENT_SECRET = "x";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/x";
		process.env.GCLOUD_PROJECT = "x";
		const env = buildIsolatedEnv(OPTS);
		expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
		expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
		expect(env.GCLOUD_PROJECT).toBeUndefined();
	});

	it("strips exact-match keys outside the prefixes", () => {
		process.env.CLAUDE_CODE_API_KEY = "x";
		process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = "1";
		process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
		process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
		const env = buildIsolatedEnv(OPTS);
		expect(env.CLAUDE_CODE_API_KEY).toBeUndefined();
		expect(env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS).toBeUndefined();
		expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
		expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
	});

	it("preserves unrelated env vars (PATH, HOME)", () => {
		process.env.PATH = "/usr/bin:/bin";
		process.env.HOME = "/home/me";
		process.env.SOME_RANDOM = "ok";
		const env = buildIsolatedEnv(OPTS);
		expect(env.PATH).toBe("/usr/bin:/bin");
		expect(env.HOME).toBe("/home/me");
		expect(env.SOME_RANDOM).toBe("ok");
	});

	it("sets the plugin-injected vars", () => {
		const env = buildIsolatedEnv({ configDir: "/cfg", tmpDir: "/tmp/ipc" });
		expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg");
		expect(env.OBSIDIAN_CC_TMP_DIR).toBe("/tmp/ipc");
		expect(env.OBSIDIAN_CC_HOOK_TIMEOUT_MS).toBe(String(HOOK_INNER_TIMEOUT_MS));
		expect(env.DISABLE_AUTOUPDATER).toBe("1");
		expect(env.NO_COLOR).toBe("1");
	});

	it("merges extras after the strip pass", () => {
		const env = buildIsolatedEnv({
			...OPTS,
			extras: { ELECTRON_RUN_AS_NODE: "1", FOO: "bar" },
		});
		expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
		expect(env.FOO).toBe("bar");
	});

	it("does not mutate process.env", () => {
		process.env.ANTHROPIC_API_KEY = "sk";
		const before = process.env.ANTHROPIC_API_KEY;
		buildIsolatedEnv(OPTS);
		expect(process.env.ANTHROPIC_API_KEY).toBe(before);
	});

	it("returns the injected vars even when caller env is empty", () => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		const env = buildIsolatedEnv(OPTS);
		expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg");
		expect(env.OBSIDIAN_CC_TMP_DIR).toBe("/tmp");
	});
});
