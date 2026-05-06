import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSlashCommands } from "./discover";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cc-slash-test-"));
});

afterEach(() => {
	// Best effort. Vitest workers reuse tmpdir naturally; leftover dirs are harmless.
});

function ensure(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("discoverSlashCommands", () => {
	it("returns empty when neither scope has a .claude/commands directory", async () => {
		const got = await discoverSlashCommands({ projectRoot: tmp, userRoot: tmp });
		expect(got).toEqual([]);
	});

	it("loads top-level commands from project scope", async () => {
		const dir = ensure(join(tmp, ".claude", "commands"));
		writeFileSync(join(dir, "review.md"), "---\ndescription: Review the diff\n---\nbody\n");
		writeFileSync(join(dir, "test.md"), "no frontmatter, just body");
		const got = await discoverSlashCommands({ projectRoot: tmp, userRoot: null });
		expect(got.map((c) => c.name).sort()).toEqual(["review", "test"]);
		const review = got.find((c) => c.name === "review")!;
		expect(review.description).toBe("Review the diff");
		expect(review.source).toBe("project");
	});

	it("recurses into subdirectories and emits namespace:command names", async () => {
		const root = ensure(join(tmp, ".claude", "commands"));
		ensure(join(root, "git"));
		writeFileSync(join(root, "git", "review.md"), "---\ndescription: Review a PR\n---\n");
		writeFileSync(join(root, "git", "fixup.md"), "");
		const got = await discoverSlashCommands({ projectRoot: tmp, userRoot: null });
		expect(got.map((c) => c.name).sort()).toEqual(["git:fixup", "git:review"]);
	});

	it("merges project + user scopes and shadows user with project on name collision", async () => {
		const projectDir = ensure(join(tmp, "project"));
		const userDir = ensure(join(tmp, "user"));
		ensure(join(projectDir, ".claude", "commands"));
		ensure(join(userDir, ".claude", "commands"));
		writeFileSync(join(projectDir, ".claude", "commands", "review.md"), "---\ndescription: project version\n---");
		writeFileSync(join(userDir, ".claude", "commands", "review.md"), "---\ndescription: user version\n---");
		writeFileSync(join(userDir, ".claude", "commands", "deploy.md"), "");
		const got = await discoverSlashCommands({ projectRoot: projectDir, userRoot: userDir });
		expect(got.map((c) => c.name)).toEqual(["review", "deploy"]);
		expect(got.find((c) => c.name === "review")!.description).toBe("project version");
		expect(got.find((c) => c.name === "review")!.source).toBe("project");
	});

	it("skips non-.md files and hidden directories handled by the OS naturally", async () => {
		const dir = ensure(join(tmp, ".claude", "commands"));
		writeFileSync(join(dir, "review.md"), "");
		writeFileSync(join(dir, "README.txt"), "not a command");
		writeFileSync(join(dir, "review.bak"), "not a command either");
		const got = await discoverSlashCommands({ projectRoot: tmp, userRoot: null });
		expect(got.map((c) => c.name)).toEqual(["review"]);
	});

	it("ignores files larger than 256 KB (those aren't templates)", async () => {
		const dir = ensure(join(tmp, ".claude", "commands"));
		writeFileSync(join(dir, "small.md"), "x");
		writeFileSync(join(dir, "huge.md"), "x".repeat(300_000));
		const got = await discoverSlashCommands({ projectRoot: tmp, userRoot: null });
		expect(got.map((c) => c.name)).toEqual(["small"]);
	});

	it("returns empty when projectRoot points at a non-existent directory", async () => {
		const got = await discoverSlashCommands({ projectRoot: join(tmp, "missing"), userRoot: null });
		expect(got).toEqual([]);
	});

	it("sorts project entries before user entries, then alphabetically within each scope", async () => {
		const projectDir = ensure(join(tmp, "project"));
		const userDir = ensure(join(tmp, "user"));
		ensure(join(projectDir, ".claude", "commands"));
		ensure(join(userDir, ".claude", "commands"));
		writeFileSync(join(projectDir, ".claude", "commands", "zoo.md"), "");
		writeFileSync(join(projectDir, ".claude", "commands", "alpha.md"), "");
		writeFileSync(join(userDir, ".claude", "commands", "beta.md"), "");
		writeFileSync(join(userDir, ".claude", "commands", "gamma.md"), "");
		const got = await discoverSlashCommands({ projectRoot: projectDir, userRoot: userDir });
		expect(got.map((c) => c.name)).toEqual(["alpha", "zoo", "beta", "gamma"]);
	});
});
