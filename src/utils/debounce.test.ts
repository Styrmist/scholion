import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("invokes the function once after the wait window", () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		d("x");
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(99);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledOnce();
		expect(fn).toHaveBeenCalledWith("x");
	});

	it("collapses N calls within the window into one (last args win)", () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		d(1);
		d(2);
		d(3);
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledOnce();
		expect(fn).toHaveBeenCalledWith(3);
	});

	it("invokes once per window when calls are spread out", () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		d("a");
		vi.advanceTimersByTime(100);
		d("b");
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn.mock.calls[0]?.[0]).toBe("a");
		expect(fn.mock.calls[1]?.[0]).toBe("b");
	});

	it("a call inside the trailing edge resets the timer", () => {
		const fn = vi.fn();
		const d = debounce(fn, 100);
		d("a");
		vi.advanceTimersByTime(99);
		d("b"); // resets the timer; original "a" should never fire
		vi.advanceTimersByTime(99);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledOnce();
		expect(fn).toHaveBeenCalledWith("b");
	});

	it("forwards multiple arguments to the wrapped function", () => {
		const fn = vi.fn();
		const d = debounce(fn, 50);
		d(1, "two", { three: 3 });
		vi.advanceTimersByTime(50);
		expect(fn).toHaveBeenCalledWith(1, "two", { three: 3 });
	});
});
