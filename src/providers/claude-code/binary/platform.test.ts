import { describe, expect, it } from "vitest";
import { detectPlatformFor, isMuslFromSignals } from "./platform";

const NEVER_MUSL = () => false;
const ALWAYS_MUSL = () => true;

describe("detectPlatformFor", () => {
	it("darwin arm64 → darwin-arm64", () => {
		expect(detectPlatformFor("darwin", "arm64", NEVER_MUSL)).toBe("darwin-arm64");
	});
	it("darwin x64 → darwin-x64", () => {
		expect(detectPlatformFor("darwin", "x64", NEVER_MUSL)).toBe("darwin-x64");
	});
	it("darwin on a non-arm64/x64 arch falls through to darwin-x64", () => {
		expect(detectPlatformFor("darwin", "ia32" as NodeJS.Architecture, NEVER_MUSL)).toBe("darwin-x64");
	});

	it("win32 arm64 → win32-arm64", () => {
		expect(detectPlatformFor("win32", "arm64", NEVER_MUSL)).toBe("win32-arm64");
	});
	it("win32 x64 → win32-x64", () => {
		expect(detectPlatformFor("win32", "x64", NEVER_MUSL)).toBe("win32-x64");
	});

	it("linux x64 glibc → linux-x64", () => {
		expect(detectPlatformFor("linux", "x64", NEVER_MUSL)).toBe("linux-x64");
	});
	it("linux x64 musl → linux-x64-musl", () => {
		expect(detectPlatformFor("linux", "x64", ALWAYS_MUSL)).toBe("linux-x64-musl");
	});
	it("linux arm64 glibc → linux-arm64", () => {
		expect(detectPlatformFor("linux", "arm64", NEVER_MUSL)).toBe("linux-arm64");
	});
	it("linux arm64 musl → linux-arm64-musl", () => {
		expect(detectPlatformFor("linux", "arm64", ALWAYS_MUSL)).toBe("linux-arm64-musl");
	});

	it("unsupported platform throws with the platform/arch in the message", () => {
		expect(() => detectPlatformFor("aix" as NodeJS.Platform, "x64", NEVER_MUSL))
			.toThrow(/aix x64/);
		expect(() => detectPlatformFor("freebsd" as NodeJS.Platform, "x64", NEVER_MUSL))
			.toThrow(/freebsd/);
	});
});

describe("isMuslFromSignals", () => {
	it("returns true if ldd output mentions 'musl' (case-insensitive)", () => {
		expect(isMuslFromSignals("ldd (musl libc) 1.2.3", null)).toBe(true);
		expect(isMuslFromSignals("MUSL libc x86_64", null)).toBe(true);
	});

	it("returns true if /proc/self/maps mentions 'ld-musl'", () => {
		expect(isMuslFromSignals(null, "abc /lib/ld-musl-x86_64.so.1 def")).toBe(true);
	});

	it("returns false on glibc-only signals", () => {
		expect(isMuslFromSignals("ldd (GNU libc) 2.36", "/lib64/ld-linux-x86-64.so.2")).toBe(false);
	});

	it("returns false when both signals are null", () => {
		expect(isMuslFromSignals(null, null)).toBe(false);
	});

	it("returns false on empty strings", () => {
		expect(isMuslFromSignals("", "")).toBe(false);
	});
});
