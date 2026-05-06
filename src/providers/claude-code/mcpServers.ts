/**
 * Pure parser for the `mcpServers` block of Claude Code's `.claude.json`.
 *
 * Read-only listing only — the plugin never writes this config. Users add /
 * remove / edit MCP servers via `claude mcp add` (or by editing the file
 * directly) and the settings panel shows them what's configured.
 *
 * The CLI accepts three transport shapes:
 *   - stdio  : `{ command, args, env }`
 *   - sse    : `{ type: "sse",  url, headers? }`
 *   - http   : `{ type: "http", url, headers? }`
 *
 * Older configs may also expose a `disabled: true` flag; we surface it.
 */

export type McpTransport = "stdio" | "sse" | "http" | "unknown";

export interface McpServerEntry {
	name: string;
	transport: McpTransport;
	/** Concise one-line description for the UI: command for stdio, URL for sse/http. */
	summary: string;
	disabled: boolean;
}

/**
 * Parse a `.claude.json`-shaped JSON string and return the configured MCP
 * servers in stable name order. Malformed JSON or missing block returns [].
 *
 * Tolerant: unknown transport shapes still come through with transport
 * `"unknown"` and a best-effort summary, so the UI never silently drops a
 * configured server.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	// Plain-object check: objects only, no arrays (arrays are objects too).
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpServers(rawJson: string): McpServerEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];
	const block = parsed["mcpServers"];
	if (!isRecord(block)) return [];
	const out: McpServerEntry[] = [];
	for (const [name, value] of Object.entries(block)) {
		if (!isRecord(value)) {
			out.push({ name, transport: "unknown", summary: "(invalid entry)", disabled: false });
			continue;
		}
		out.push(parseEntry(name, value));
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

function parseEntry(name: string, entry: Record<string, unknown>): McpServerEntry {
	const disabled = entry["disabled"] === true;
	const rawType = entry["type"];
	const declaredType = typeof rawType === "string" ? rawType.toLowerCase() : null;
	if (declaredType === "sse" || declaredType === "http") {
		const url = typeof entry["url"] === "string" ? entry["url"] : "";
		return {
			name,
			transport: declaredType,
			summary: url || "(no URL)",
			disabled,
		};
	}
	const command = entry["command"];
	if (typeof command === "string") {
		const argsRaw = entry["args"];
		const args = Array.isArray(argsRaw)
			? argsRaw.filter((a): a is string => typeof a === "string")
			: [];
		const summary = [command, ...args].join(" ").trim();
		return {
			name,
			transport: "stdio",
			summary: summary || command,
			disabled,
		};
	}
	const url = entry["url"];
	if (typeof url === "string") {
		// URL present but no `type` — assume sse (the older default).
		return {
			name,
			transport: "sse",
			summary: url,
			disabled,
		};
	}
	return { name, transport: "unknown", summary: "(no command or URL configured)", disabled };
}
