import { describe, expect, it } from "vitest";
import {
	detectMentionQuery,
	MentionCandidate,
	parseMentions,
	rankMentionCandidates,
	resolveMentions,
} from "./mentions";

describe("parseMentions", () => {
	it("returns empty for plain text", () => {
		expect(parseMentions("hello world")).toEqual([]);
	});

	it("extracts a single mention", () => {
		expect(parseMentions("see @[[Notes]] please")).toEqual([
			{ name: "Notes", startIndex: 4 },
		]);
	});

	it("preserves document order across multiple mentions", () => {
		const out = parseMentions("first @[[A]] then @[[B]] last");
		expect(out.map((m) => m.name)).toEqual(["A", "B"]);
		expect(out[0]!.startIndex).toBeLessThan(out[1]!.startIndex);
	});

	it("dedupes by name, keeping the first occurrence's index", () => {
		const out = parseMentions("@[[A]] @[[A]]");
		expect(out).toHaveLength(1);
		expect(out[0]!.name).toBe("A");
		expect(out[0]!.startIndex).toBe(0);
	});

	it("trims surrounding whitespace inside the brackets", () => {
		expect(parseMentions("@[[  spaced  ]]")).toEqual([
			{ name: "spaced", startIndex: 0 },
		]);
	});

	it("drops empty / whitespace-only names", () => {
		expect(parseMentions("@[[]] @[[   ]]")).toEqual([]);
	});

	it("skips a malformed mention with a stray inner bracket but keeps surrounding valid ones", () => {
		// The middle is malformed (extra `]` before the closer), so the regex
		// fails to match it entirely. Surrounding well-formed mentions still parse.
		const out = parseMentions("@[[A]] @[[B]extra]] @[[C]]");
		expect(out.map((m) => m.name)).toEqual(["A", "C"]);
	});

	it("handles paths with slashes inside the link body", () => {
		expect(parseMentions("@[[folder/Note]]")).toEqual([
			{ name: "folder/Note", startIndex: 0 },
		]);
	});

	it("supports mentions glued to surrounding punctuation", () => {
		const out = parseMentions("(see @[[A]]) and@[[B]]end");
		expect(out.map((m) => m.name)).toEqual(["A", "B"]);
	});
});

describe("resolveMentions", () => {
	it("preserves order and reports unresolved entries with null", () => {
		const lookup: Record<string, string> = { A: "Notes/A.md" };
		const out = resolveMentions(
			[
				{ name: "A", startIndex: 0 },
				{ name: "Missing", startIndex: 10 },
			],
			(name) => lookup[name] ?? null,
		);
		expect(out).toEqual([
			{ name: "A", path: "Notes/A.md" },
			{ name: "Missing", path: null },
		]);
	});

	it("returns empty for empty input", () => {
		expect(resolveMentions([], () => null)).toEqual([]);
	});
});

describe("detectMentionQuery", () => {
	it("returns null when there is no @ before the cursor", () => {
		expect(detectMentionQuery("just typing")).toBeNull();
	});

	it("captures an empty query right after typing @", () => {
		expect(detectMentionQuery("hello @")).toEqual({ query: "", triggerStart: 6 });
	});

	it("captures partial query as the user types", () => {
		expect(detectMentionQuery("hello @No")).toEqual({ query: "No", triggerStart: 6 });
	});

	it("ignores @ that is preceded by a word char (email-like)", () => {
		expect(detectMentionQuery("user@example")).toBeNull();
	});

	it("recognizes @ at the very start of the input", () => {
		expect(detectMentionQuery("@x")).toEqual({ query: "x", triggerStart: 0 });
	});

	it("does not span past whitespace", () => {
		// Whitespace between `@` and cursor means the user moved past the mention.
		expect(detectMentionQuery("@notes here")).toBeNull();
	});

	it("rejects when the query already contains a closing bracket", () => {
		// Cursor inside an existing wikilink — don't re-pop the autocomplete.
		expect(detectMentionQuery("@[[Done]")).toBeNull();
	});

	it("ignores @ that is buried behind whitespace from cursor", () => {
		expect(detectMentionQuery("@a but later text")).toBeNull();
	});
});

describe("rankMentionCandidates", () => {
	const candidates: MentionCandidate[] = [
		{ basename: "Apple", path: "fruits/Apple.md" },
		{ basename: "Application", path: "tech/Application.md" },
		{ basename: "Banana", path: "fruits/Banana.md" },
		{ basename: "Snapshot", path: "logs/Snapshot.md" },
	];

	it("returns the input order (truncated) when query is empty", () => {
		expect(rankMentionCandidates(candidates, "", 2)).toEqual(candidates.slice(0, 2));
	});

	it("prefers basename prefix matches over substring matches", () => {
		const out = rankMentionCandidates(candidates, "ap", 10);
		// Apple and Application both prefix-match, Snapshot substring-matches.
		expect(out.map((c) => c.basename)).toEqual(["Apple", "Application", "Snapshot"]);
	});

	it("falls back to path-substring when basename does not match", () => {
		const out = rankMentionCandidates(candidates, "logs", 10);
		expect(out.map((c) => c.basename)).toEqual(["Snapshot"]);
	});

	it("excludes candidates that match nothing", () => {
		const out = rankMentionCandidates(candidates, "zzz", 10);
		expect(out).toEqual([]);
	});

	it("respects the limit", () => {
		const out = rankMentionCandidates(candidates, "a", 2);
		expect(out).toHaveLength(2);
	});

	it("matches case-insensitively", () => {
		const out = rankMentionCandidates(candidates, "APPLE", 10);
		expect(out[0]!.basename).toBe("Apple");
	});
});
