import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasOauthAccount, redactSecrets } from "./auth";

describe("redactSecrets", () => {
	it("redacts code= query param", () => {
		const out = redactSecrets("callback?code=ABC-123_xyz&state=foo");
		expect(out).toContain("code=<redacted>");
		expect(out).not.toContain("ABC-123_xyz");
	});

	it("redacts access_token in URL params", () => {
		const out = redactSecrets("token=abc&access_token=secret123 trailing");
		expect(out).toContain("access_token=<redacted>");
		expect(out).not.toContain("secret123");
	});

	it("redacts refresh_token in URL params", () => {
		const out = redactSecrets("?refresh_token=xyz789 next");
		expect(out).toContain("refresh_token=<redacted>");
		expect(out).not.toContain("xyz789");
	});

	it("is idempotent: a second pass leaves redacted output unchanged", () => {
		const once = redactSecrets("code=AAA access_token=BBB refresh_token=CCC");
		const twice = redactSecrets(once);
		expect(twice).toBe(once);
	});

	it("leaves unrelated text alone", () => {
		const text = "Opening browser to https://claude.ai/login no secrets here";
		expect(redactSecrets(text)).toBe(text);
	});

	it("redacts case-insensitively (CODE=)", () => {
		const out = redactSecrets("CODE=ABCDEF");
		expect(out).toContain("code=<redacted>");
	});
});

describe("hasOauthAccount", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-auth-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns false when .claude.json is missing", () => {
		expect(hasOauthAccount(dir)).toBe(false);
	});

	it("returns true when oauthAccount.emailAddress is set", () => {
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({ oauthAccount: { emailAddress: "u@example.com" } }),
		);
		expect(hasOauthAccount(dir)).toBe(true);
	});

	it("returns false when oauthAccount block is missing", () => {
		writeFileSync(join(dir, ".claude.json"), JSON.stringify({ other: 1 }));
		expect(hasOauthAccount(dir)).toBe(false);
	});

	it("returns false when oauthAccount has no emailAddress", () => {
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({ oauthAccount: {} }),
		);
		expect(hasOauthAccount(dir)).toBe(false);
	});

	it("returns false when JSON is malformed", () => {
		writeFileSync(join(dir, ".claude.json"), "{not json");
		expect(hasOauthAccount(dir)).toBe(false);
	});
});
