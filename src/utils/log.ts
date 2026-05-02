let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
	verboseEnabled = enabled;
}

export function log(...args: unknown[]): void {
	if (verboseEnabled) console.debug("[claude-code]", ...args);
}

export function warn(...args: unknown[]): void {
	console.warn("[claude-code]", ...args);
}

export function error(...args: unknown[]): void {
	console.error("[claude-code]", ...args);
}
