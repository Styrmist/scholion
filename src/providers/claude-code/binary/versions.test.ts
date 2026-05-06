import { describe, expect, it } from "vitest";
import { binaryUrl, manifestChecksum } from "./versions";
import { ReleaseManifest } from "../../../types";
import { DOWNLOADS_BASE } from "../../../constants";

describe("binaryUrl", () => {
	it("uses 'claude' on Unix-style platforms", () => {
		expect(binaryUrl("1.2.3", "darwin-arm64")).toBe(`${DOWNLOADS_BASE}/1.2.3/darwin-arm64/claude`);
		expect(binaryUrl("1.2.3", "linux-x64")).toBe(`${DOWNLOADS_BASE}/1.2.3/linux-x64/claude`);
		expect(binaryUrl("1.2.3", "linux-x64-musl")).toBe(`${DOWNLOADS_BASE}/1.2.3/linux-x64-musl/claude`);
	});

	it("uses 'claude.exe' on Windows platforms", () => {
		expect(binaryUrl("9.9.9", "win32-x64")).toBe(`${DOWNLOADS_BASE}/9.9.9/win32-x64/claude.exe`);
		expect(binaryUrl("9.9.9", "win32-arm64")).toBe(`${DOWNLOADS_BASE}/9.9.9/win32-arm64/claude.exe`);
	});
});

describe("manifestChecksum", () => {
	const manifest: ReleaseManifest = {
		version: "1.2.3",
		platforms: {
			"darwin-arm64": { checksum: "ABCDEF" },
			"linux-x64": { checksum: "deadbeef" },
		},
	};

	it("returns the checksum for a known platform, lowercased", () => {
		expect(manifestChecksum(manifest, "darwin-arm64")).toBe("abcdef");
	});

	it("returns existing-lowercase checksums unchanged", () => {
		expect(manifestChecksum(manifest, "linux-x64")).toBe("deadbeef");
	});

	it("throws with the platform name when missing", () => {
		expect(() => manifestChecksum(manifest, "win32-x64"))
			.toThrow(/win32-x64/);
	});

	it("throws when the platform entry exists but has no checksum", () => {
		const m: ReleaseManifest = {
			version: "1",
			platforms: { "darwin-arm64": { checksum: "" } },
		};
		expect(() => manifestChecksum(m, "darwin-arm64")).toThrow(/checksum/i);
	});
});
