import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { ClaudePlatform } from "../types";

export function detectPlatform(): ClaudePlatform {
	return detectPlatformFor(process.platform, process.arch, isMusl);
}

/** Pure dispatch on (platform, arch); musl detection is injected for testability. */
export function detectPlatformFor(
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
	muslCheck: () => boolean,
): ClaudePlatform {
	if (platform === "darwin") {
		return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	}
	if (platform === "win32") {
		return arch === "arm64" ? "win32-arm64" : "win32-x64";
	}
	if (platform === "linux") {
		const musl = muslCheck();
		if (arch === "arm64") return musl ? "linux-arm64-musl" : "linux-arm64";
		return musl ? "linux-x64-musl" : "linux-x64";
	}
	throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

/** Returns true if either signal indicates a musl libc. Both are pure on their inputs. */
export function isMuslFromSignals(lddOutput: string | null, procSelfMaps: string | null): boolean {
	if (lddOutput && /musl/i.test(lddOutput)) return true;
	if (procSelfMaps && /ld-musl/i.test(procSelfMaps)) return true;
	return false;
}

function isMusl(): boolean {
	let lddOutput: string | null = null;
	try {
		lddOutput = execSync("ldd --version 2>&1", { encoding: "utf8" });
	} catch {
		// `ldd` may exit non-zero but still print version info we can read; fall through
	}
	let mapsContents: string | null = null;
	try {
		if (existsSync("/proc/self/maps")) {
			mapsContents = readFileSync("/proc/self/maps", "utf8");
		}
	} catch {
		// ignore
	}
	return isMuslFromSignals(lddOutput, mapsContents);
}

export function isWindows(): boolean {
	return process.platform === "win32";
}
