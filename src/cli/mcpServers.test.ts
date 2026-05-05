import { describe, expect, it } from "vitest";
import { parseMcpServers } from "./mcpServers";

describe("parseMcpServers", () => {
	it("returns [] for an empty / non-JSON input", () => {
		expect(parseMcpServers("")).toEqual([]);
		expect(parseMcpServers("not json")).toEqual([]);
		expect(parseMcpServers("null")).toEqual([]);
	});

	it("returns [] when mcpServers is missing", () => {
		expect(parseMcpServers(JSON.stringify({ otherKey: 1 }))).toEqual([]);
	});

	it("returns [] when mcpServers is not an object", () => {
		expect(parseMcpServers(JSON.stringify({ mcpServers: ["nope"] }))).toEqual([]);
	});

	it("parses a stdio entry with command + args", () => {
		const json = JSON.stringify({
			mcpServers: {
				myServer: { command: "node", args: ["server.js", "--flag"] },
			},
		});
		expect(parseMcpServers(json)).toEqual([
			{
				name: "myServer",
				transport: "stdio",
				summary: "node server.js --flag",
				disabled: false,
			},
		]);
	});

	it("parses a stdio entry with command but no args", () => {
		const json = JSON.stringify({ mcpServers: { s: { command: "/usr/bin/foo" } } });
		expect(parseMcpServers(json)[0]).toMatchObject({
			transport: "stdio",
			summary: "/usr/bin/foo",
		});
	});

	it("filters non-string args", () => {
		const json = JSON.stringify({
			mcpServers: { s: { command: "node", args: ["a", 5, null, "b"] } },
		});
		expect(parseMcpServers(json)[0]!.summary).toBe("node a b");
	});

	it("parses an explicit sse entry", () => {
		const json = JSON.stringify({
			mcpServers: {
				webMcp: { type: "sse", url: "https://example.com/sse" },
			},
		});
		expect(parseMcpServers(json)).toEqual([
			{
				name: "webMcp",
				transport: "sse",
				summary: "https://example.com/sse",
				disabled: false,
			},
		]);
	});

	it("parses an explicit http entry", () => {
		const json = JSON.stringify({
			mcpServers: {
				h: { type: "HTTP", url: "https://example.com/api" },
			},
		});
		const out = parseMcpServers(json)[0]!;
		// type is normalized to lowercase
		expect(out.transport).toBe("http");
		expect(out.summary).toBe("https://example.com/api");
	});

	it("falls back to sse when url is set but no type is declared", () => {
		const json = JSON.stringify({
			mcpServers: { legacy: { url: "https://x.test" } },
		});
		expect(parseMcpServers(json)[0]!.transport).toBe("sse");
	});

	it("surfaces the disabled flag", () => {
		const json = JSON.stringify({
			mcpServers: { s: { command: "x", disabled: true } },
		});
		expect(parseMcpServers(json)[0]!.disabled).toBe(true);
	});

	it("returns 'unknown' transport for malformed entries instead of dropping", () => {
		const json = JSON.stringify({
			mcpServers: {
				bad: { somethingElse: 1 },
				broken: 42,
			},
		});
		const out = parseMcpServers(json);
		expect(out.find((e) => e.name === "bad")?.transport).toBe("unknown");
		expect(out.find((e) => e.name === "broken")?.transport).toBe("unknown");
	});

	it("sorts entries by name", () => {
		const json = JSON.stringify({
			mcpServers: {
				zeta: { command: "z" },
				alpha: { command: "a" },
				mid: { command: "m" },
			},
		});
		const names = parseMcpServers(json).map((e) => e.name);
		expect(names).toEqual(["alpha", "mid", "zeta"]);
	});
});
