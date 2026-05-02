import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { ClaudePlatform } from "../types";

export function detectPlatform(): ClaudePlatform {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "darwin") {
		return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	}
	if (platform === "win32") {
		return arch === "arm64" ? "win32-arm64" : "win32-x64";
	}
	if (platform === "linux") {
		const musl = isMusl();
		if (arch === "arm64") return musl ? "linux-arm64-musl" : "linux-arm64";
		return musl ? "linux-x64-musl" : "linux-x64";
	}
	throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

function isMusl(): boolean {
	try {
		const out = execSync("ldd --version 2>&1", { encoding: "utf8" });
		if (/musl/i.test(out)) return true;
	} catch {
		// `ldd` may exit non-zero but still print version info we can read; fall through
	}
	try {
		if (existsSync("/proc/self/maps")) {
			const maps = readFileSync("/proc/self/maps", "utf8");
			if (/ld-musl/i.test(maps)) return true;
		}
	} catch {
		// ignore
	}
	return false;
}

export function isWindows(): boolean {
	return process.platform === "win32";
}
