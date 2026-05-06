let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
	verboseEnabled = enabled;
}

export function log(...args: unknown[]): void {
	if (verboseEnabled) console.debug("[scholion]", ...args);
}

export function warn(...args: unknown[]): void {
	console.warn("[scholion]", ...args);
}

export function error(...args: unknown[]): void {
	console.error("[scholion]", ...args);
}
