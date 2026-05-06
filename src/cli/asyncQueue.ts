// Single-producer, single-consumer async queue with explicit close/error.
// Used to bridge a callback-driven event source (the Claude CLI runner) into
// an AsyncIterable consumed by the turn coordinator.
//
// Backpressure note: producer never blocks; if the consumer falls behind, the
// queue grows unbounded in memory. This is intentional — the existing runner
// already buffers stdout via Node's pipe, and we mirror that behavior. If the
// queue ever needs a hard cap, add a `limit` constructor arg + a Promise gate
// the producer awaits when full.

interface Pending<T> {
	resolve: (value: IteratorResult<T>) => void;
	reject: (reason: unknown) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
	private readonly buffer: T[] = [];
	private readonly waiters: Pending<T>[] = [];
	private closed = false;
	private failure: { error: unknown } | null = null;

	push(value: T): void {
		if (this.closed || this.failure) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve({ value, done: false });
			return;
		}
		this.buffer.push(value);
	}

	close(): void {
		if (this.closed || this.failure) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			const w = this.waiters.shift()!;
			w.resolve({ value: undefined, done: true });
		}
	}

	error(err: unknown): void {
		if (this.closed || this.failure) return;
		this.failure = { error: err };
		while (this.waiters.length > 0) {
			const w = this.waiters.shift()!;
			w.reject(err);
		}
	}

	next(): Promise<IteratorResult<T>> {
		if (this.buffer.length > 0) {
			const value = this.buffer.shift()!;
			return Promise.resolve({ value, done: false });
		}
		if (this.failure) return Promise.reject(this.failure.error);
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	return(): Promise<IteratorResult<T>> {
		this.close();
		return Promise.resolve({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
}
