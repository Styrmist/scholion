import { Readable } from "stream";
import { describe, expect, it, vi } from "vitest";
import { lineStream } from "./ndjson";
import * as logger from "../../utils/log";

async function collect(stream: NodeJS.ReadableStream): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const v of lineStream(stream)) out.push(v);
	return out;
}

function mkStream(chunks: Array<string | Buffer>): NodeJS.ReadableStream {
	return Readable.from(chunks);
}

describe("lineStream", () => {
	it("yields multiple complete lines from a single chunk", async () => {
		const out = await collect(mkStream(['{"a":1}\n{"b":2}\n']));
		expect(out).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reassembles a JSON value split across multiple chunks", async () => {
		const out = await collect(mkStream(['{"hel', 'lo":', '"world"}\n']));
		expect(out).toEqual([{ hello: "world" }]);
	});

	it("flushes a trailing line that has no newline", async () => {
		const out = await collect(mkStream(['{"final":true}']));
		expect(out).toEqual([{ final: true }]);
	});

	it("skips empty/whitespace-only lines", async () => {
		const out = await collect(mkStream(['\n\n   \n{"x":1}\n\n']));
		expect(out).toEqual([{ x: 1 }]);
	});

	it("handles UTF-8 multi-byte characters split across chunk boundaries", async () => {
		// "héllo" — `é` is 0xC3 0xA9 in UTF-8. Split inside that 2-byte sequence.
		const full = Buffer.from('{"x":"héllo"}\n', "utf8");
		const idx = full.indexOf(0xc3);
		const c1 = full.subarray(0, idx + 1);
		const c2 = full.subarray(idx + 1);
		const out = await collect(mkStream([c1, c2]));
		expect(out).toEqual([{ x: "héllo" }]);
	});

	it("logs and skips malformed JSON, then continues with the next line", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			const out = await collect(mkStream(['{not json}\n{"ok":1}\n']));
			expect(out).toEqual([{ ok: 1 }]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toMatch(/Failed to parse NDJSON line/);
		} finally {
			warn.mockRestore();
		}
	});

	it("returns nothing for an empty stream", async () => {
		expect(await collect(mkStream([]))).toEqual([]);
	});

	it("handles many small Buffer chunks without losing data", async () => {
		const payload = '{"id":1}\n{"id":2}\n{"id":3}\n';
		const chunks = Array.from(payload).map((c) => Buffer.from(c, "utf8"));
		const out = await collect(mkStream(chunks));
		expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});
});
