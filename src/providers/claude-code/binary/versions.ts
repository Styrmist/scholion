import { DOWNLOADS_BASE } from "../../../constants";
import { ClaudePlatform, ReleaseManifest } from "../../../types";
import { fetchText } from "../../../utils/fs";

export async function fetchLatestVersion(): Promise<string> {
	const candidates = [
		`${DOWNLOADS_BASE}/stable`,
		`${DOWNLOADS_BASE}/latest`,
	];
	let lastError: unknown;
	for (const url of candidates) {
		try {
			const body = (await fetchText(url)).trim();
			const match = body.match(/\d+\.\d+\.\d+/);
			if (match) return match[0];
		} catch (e) {
			lastError = e;
		}
	}
	throw new Error(
		`Could not resolve latest Claude Code version: ${(lastError as Error)?.message ?? "unknown"}`
	);
}

export async function fetchManifest(version: string): Promise<ReleaseManifest> {
	const { parsed } = await fetchManifestWithRaw(version);
	return parsed;
}

/**
 * Fetch the manifest and return both the raw signed bytes (for verification)
 * and the parsed object. The signature was made over the raw text, so we must
 * not parse-and-restringify before verifying.
 */
export async function fetchManifestWithRaw(version: string): Promise<{ text: string; parsed: ReleaseManifest }> {
	const url = `${DOWNLOADS_BASE}/${version}/manifest.json`;
	const text = await fetchText(url);
	const parsed = JSON.parse(text) as ReleaseManifest;
	if (!parsed || typeof parsed !== "object" || !parsed.platforms) {
		throw new Error(`Invalid manifest at ${url}`);
	}
	if (!parsed.version) parsed.version = version;
	return { text, parsed };
}

export async function fetchManifestSignature(version: string): Promise<string> {
	return fetchText(`${DOWNLOADS_BASE}/${version}/manifest.json.sig`);
}

export function binaryUrl(version: string, platform: ClaudePlatform): string {
	const filename = platform.startsWith("win32") ? "claude.exe" : "claude";
	return `${DOWNLOADS_BASE}/${version}/${platform}/${filename}`;
}

export function manifestChecksum(manifest: ReleaseManifest, platform: ClaudePlatform): string {
	const entry = manifest.platforms[platform];
	if (!entry || !entry.checksum) {
		throw new Error(`No checksum in manifest for platform "${platform}"`);
	}
	return entry.checksum.toLowerCase();
}
