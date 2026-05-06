import type { NormalizedError, NormalizedErrorCode } from "../../backend/types";

const LOST_SESSION_PATTERN =
	/session.*not\s*found|unknown\s*session|no\s*conversation\s*found/i;
const AUTH_REQUIRED_PATTERN =
	/(?:401|unauthorized|invalid\s*api\s*key|not\s*signed\s*in|please\s*sign\s*in|login\s*required)/i;
const RATE_LIMITED_PATTERN = /(?:429|rate\s*limit|too\s*many\s*requests)/i;
const BINARY_MISSING_PATTERN =
	/(?:enoent|command\s*not\s*found|binary.*not\s*found)/i;
const TRANSPORT_PATTERN =
	/(?:econnrefused|enotfound|etimedout|network\s*error|fetch\s*failed)/i;

export interface RawErrorInput {
	stderr?: string;
	resultErrors?: string[];
	status?: "success" | "error" | "aborted";
	permissionDenied?: { tool: string; reason: string };
	subtype?: string;
}

export function mapClaudeError(input: RawErrorInput): NormalizedError {
	const haystack = [
		input.stderr ?? "",
		...(input.resultErrors ?? []),
		input.subtype ?? "",
	]
		.filter(Boolean)
		.join("\n");

	if (input.status === "aborted") {
		return {
			code: "aborted",
			message: input.resultErrors?.[0] ?? "Turn aborted",
			raw: input,
		};
	}

	if (input.permissionDenied) {
		return {
			code: "permission_denied",
			message: input.permissionDenied.reason,
			raw: input,
		};
	}

	const code = classify(haystack);
	const message = haystack.trim() || "Unknown backend error";
	return { code, message, raw: input };
}

function classify(haystack: string): NormalizedErrorCode {
	if (!haystack) return "unknown";
	if (LOST_SESSION_PATTERN.test(haystack)) return "session_not_found";
	if (AUTH_REQUIRED_PATTERN.test(haystack)) return "auth_required";
	if (RATE_LIMITED_PATTERN.test(haystack)) return "rate_limited";
	if (BINARY_MISSING_PATTERN.test(haystack)) return "binary_missing";
	if (TRANSPORT_PATTERN.test(haystack)) return "transport";
	return "unknown";
}

// Exposed for the existing TurnCoordinator regex check until Stage 5 swaps it.
export { LOST_SESSION_PATTERN };
