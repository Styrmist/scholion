import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./asyncQueue";

describe("AsyncQueue", () => {
	it("delivers buffered values in order", async () => {
		const q = new AsyncQueue<number>();
		q.push(1);
		q.push(2);
		q.push(3);
		q.close();
		const collected: number[] = [];
		for await (const v of q) collected.push(v);
		expect(collected).toEqual([1, 2, 3]);
	});

	it("resolves a pending consumer when push arrives", async () => {
		const q = new AsyncQueue<string>();
		const promise = (async () => {
			const out: string[] = [];
			for await (const v of q) out.push(v);
			return out;
		})();
		q.push("a");
		q.push("b");
		q.close();
		await expect(promise).resolves.toEqual(["a", "b"]);
	});

	it("close on an empty queue ends iteration immediately", async () => {
		const q = new AsyncQueue<number>();
		q.close();
		const out: number[] = [];
		for await (const v of q) out.push(v);
		expect(out).toEqual([]);
	});

	it("error rejects a pending consumer", async () => {
		const q = new AsyncQueue<number>();
		const promise = (async () => {
			for await (const _ of q) void _;
		})();
		q.error(new Error("boom"));
		await expect(promise).rejects.toThrow("boom");
	});

	it("error rejects a future consumer call", async () => {
		const q = new AsyncQueue<number>();
		q.error(new Error("late"));
		await expect(q.next()).rejects.toThrow("late");
	});

	it("ignores push after close", async () => {
		const q = new AsyncQueue<number>();
		q.push(1);
		q.close();
		q.push(2);
		const out: number[] = [];
		for await (const v of q) out.push(v);
		expect(out).toEqual([1]);
	});

	it("return() short-circuits the iterator", async () => {
		const q = new AsyncQueue<number>();
		q.push(1);
		q.push(2);
		const out: number[] = [];
		for await (const v of q) {
			out.push(v);
			if (v === 1) break;
		}
		expect(out).toEqual([1]);
	});
});
