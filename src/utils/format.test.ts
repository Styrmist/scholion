import { describe, expect, it } from "vitest";
import { formatBytes, formatTokens, formatUsage } from "./format";
import { SessionUsage } from "../types";

describe("formatBytes", () => {
	it("uses 'B' suffix for under 1024", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1)).toBe("1 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("crosses to KB at 1024", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
	});

	it("KB stays at 1 decimal up to just under 1MB", () => {
		expect(formatBytes(1024 * 100)).toBe("100.0 KB");
		expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
	});

	it("crosses to MB at 1024*1024 with 2 decimals", () => {
		expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
	});

	it("scales MB linearly", () => {
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
	});
});

describe("formatTokens", () => {
	it("returns the raw number for n < 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(1)).toBe("1");
		expect(formatTokens(999)).toBe("999");
	});

	it("uses 1 decimal in the [1k, 10k) band", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(5200)).toBe("5.2k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("rounds to whole k for n >= 10k", () => {
		expect(formatTokens(10_000)).toBe("10k");
		expect(formatTokens(10_400)).toBe("10k");
		expect(formatTokens(10_500)).toBe("11k");
		expect(formatTokens(999_999)).toBe("1000k");
	});
});

describe("formatUsage", () => {
	function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
		return {
			totalCostUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			...overrides,
		};
	}

	it("renders cost with 4 decimals and tokens with the formatTokens scale", () => {
		const out = formatUsage(usage({
			totalCostUsd: 0.0123,
			inputTokens: 5_200,
			outputTokens: 12_000,
		}));
		expect(out).toBe("$0.0123 · 5.2k in / 12k out");
	});

	it("renders zero cost as $0.0000", () => {
		const out = formatUsage(usage({ inputTokens: 1, outputTokens: 1 }));
		expect(out).toBe("$0.0000 · 1 in / 1 out");
	});

	it("preserves all four decimal places (no scientific notation)", () => {
		const out = formatUsage(usage({ totalCostUsd: 0.00009 }));
		expect(out.startsWith("$0.0001")).toBe(true);
	});
});
