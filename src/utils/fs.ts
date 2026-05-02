import { createHash } from "crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	promises as fsp,
	renameSync,
	statSync,
	unlinkSync,
} from "fs";
import { get as httpGet } from "http";
import { get as httpsGet } from "https";
import { dirname } from "path";

export function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmp, path);
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
	try {
		const raw = await fsp.readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		throw e;
	}
}

export async function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

export interface DownloadResult {
	sha256: string;
	bytes: number;
}

export function downloadToFileWithHash(
	url: string,
	destPath: string,
	onProgress?: (received: number, total: number | null) => void
): Promise<DownloadResult> {
	ensureDir(dirname(destPath));

	return new Promise<DownloadResult>((resolve, reject) => {
		const hash = createHash("sha256");
		let bytes = 0;
		let total: number | null = null;
		const out = createWriteStream(destPath);
		let settled = false;

		const cleanup = () => {
			try { out.destroy(); } catch { /* ignore */ }
			try {
				if (existsSync(destPath)) unlinkSync(destPath);
			} catch { /* ignore */ }
		};

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		const succeed = (result: DownloadResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const fetchOnce = (currentUrl: string, redirectsLeft: number) => {
			const lib = currentUrl.startsWith("https:") ? httpsGet : httpGet;
			const req = lib(currentUrl, (res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					if (redirectsLeft <= 0) {
						res.resume();
						fail(new Error("Too many redirects"));
						return;
					}
					res.resume();
					fetchOnce(res.headers.location, redirectsLeft - 1);
					return;
				}
				if (status !== 200) {
					res.resume();
					fail(new Error(`HTTP ${status} for ${currentUrl}`));
					return;
				}
				const lengthHeader = res.headers["content-length"];
				total = lengthHeader ? Number(lengthHeader) : null;
				res.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					hash.update(chunk);
					if (onProgress) onProgress(bytes, total);
				});
				res.on("error", (err) => fail(err));
				res.pipe(out);
			});
			req.on("error", (err) => fail(err));
		};

		out.on("error", (err) => fail(err));
		out.on("finish", () => succeed({ sha256: hash.digest("hex"), bytes }));

		fetchOnce(url, 5);
	});
}

export function fetchText(url: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const fetchOnce = (currentUrl: string, redirectsLeft: number) => {
			const lib = currentUrl.startsWith("https:") ? httpsGet : httpGet;
			const req = lib(currentUrl, (res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					if (redirectsLeft <= 0) {
						res.resume();
						reject(new Error("Too many redirects"));
						return;
					}
					res.resume();
					fetchOnce(res.headers.location, redirectsLeft - 1);
					return;
				}
				if (status !== 200) {
					res.resume();
					reject(new Error(`HTTP ${status} for ${currentUrl}`));
					return;
				}
				let buf = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => { buf += chunk; });
				res.on("end", () => resolve(buf));
				res.on("error", reject);
			});
			req.on("error", reject);
		};
		fetchOnce(url, 5);
	});
}

export function fileAgeMs(path: string): number | null {
	try {
		const s = statSync(path);
		return Date.now() - s.mtimeMs;
	} catch {
		return null;
	}
}

export function hashString(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}
