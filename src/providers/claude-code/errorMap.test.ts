import { describe, expect, it } from "vitest";
import { mapClaudeError } from "./errorMap";

describe("mapClaudeError", () => {
	it("aborted status wins regardless of message contents", () => {
		const r = mapClaudeError({
			status: "aborted",
			stderr: "401 unauthorized — should be ignored when aborted",
		});
		expect(r.code).toBe("aborted");
	});

	it("permission denial wins over message classification", () => {
		const r = mapClaudeError({
			status: "error",
			permissionDenied: { tool: "Bash", reason: "denied by hook" },
			stderr: "rate limit exceeded",
		});
		expect(r.code).toBe("permission_denied");
		expect(r.message).toBe("denied by hook");
	});

	it("classifies session-not-found stderr", () => {
		expect(
			mapClaudeError({ stderr: "Error: session not found", status: "error" })
				.code,
		).toBe("session_not_found");
		expect(
			mapClaudeError({
				resultErrors: ["unknown session abc-123"],
				status: "error",
			}).code,
		).toBe("session_not_found");
		expect(
			mapClaudeError({
				stderr: "no conversation found for resume",
				status: "error",
			}).code,
		).toBe("session_not_found");
	});

	it("classifies auth-required messages", () => {
		expect(
			mapClaudeError({ stderr: "401 Unauthorized", status: "error" }).code,
		).toBe("auth_required");
		expect(
			mapClaudeError({ stderr: "Please sign in to continue", status: "error" })
				.code,
		).toBe("auth_required");
		expect(
			mapClaudeError({ stderr: "invalid API key", status: "error" }).code,
		).toBe("auth_required");
	});

	it("classifies rate-limit messages", () => {
		expect(
			mapClaudeError({ stderr: "429 Too Many Requests", status: "error" })
				.code,
		).toBe("rate_limited");
		expect(
			mapClaudeError({ stderr: "rate limit reached", status: "error" }).code,
		).toBe("rate_limited");
	});

	it("classifies binary-missing messages", () => {
		expect(
			mapClaudeError({
				stderr: "ENOENT: no such file or directory",
				status: "error",
			}).code,
		).toBe("binary_missing");
	});

	it("classifies transport errors", () => {
		expect(
			mapClaudeError({ stderr: "ECONNREFUSED 127.0.0.1:443", status: "error" })
				.code,
		).toBe("transport");
		expect(
			mapClaudeError({ stderr: "fetch failed", status: "error" }).code,
		).toBe("transport");
	});

	it("falls back to unknown when nothing matches", () => {
		expect(mapClaudeError({ stderr: "🦄 surprise", status: "error" }).code).toBe(
			"unknown",
		);
	});

	it("returns 'Unknown backend error' message when haystack is empty", () => {
		expect(mapClaudeError({ status: "error" }).message).toBe(
			"Unknown backend error",
		);
	});
});
