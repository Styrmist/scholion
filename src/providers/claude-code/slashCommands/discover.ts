/**
 * Filesystem walker that loads slash commands from the standard
 * `.claude/commands/` directories, mirroring the CLI's discovery rules.
 * Pure parsing/ranking lives in `slashCommands.ts`; this module supplies
 * the I/O.
 */

import { promises as fsp } from "fs";
import { homedir } from "os";
import { join, relative, sep } from "path";
import {
	commandNameFromPath,
	parseCommandFrontmatter,
	SlashCommand,
	SlashCommandSource,
} from "./frontmatter";

export interface DiscoverInput {
	/** Project scope root, typically the vault path. The walker reads
	 *  `<projectRoot>/.claude/commands/**` if it exists. Pass null to skip. */
	projectRoot: string | null;
	/** User scope root, typically `~`. Pass null to skip (e.g. on a system
	 *  without a writable HOME). The walker reads `<userRoot>/.claude/commands/**`. */
	userRoot: string | null;
}

const COMMANDS_SUBPATH = join(".claude", "commands");
const MAX_COMMANDS_PER_SCOPE = 200;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Walk both scopes and return discovered commands. Project scope is listed
 * first so a project command of the same name shadows a user-level one in
 * the picker (which sorts by source: project before user). I/O errors and
 * unreadable files are swallowed — discovery is best-effort and the absence
 * of any commands is the normal first-run state.
 */
export async function discoverSlashCommands(input: DiscoverInput): Promise<SlashCommand[]> {
	const project = input.projectRoot
		? await loadFromScope(join(input.projectRoot, COMMANDS_SUBPATH), "project")
		: [];
	const user = input.userRoot
		? await loadFromScope(join(input.userRoot, COMMANDS_SUBPATH), "user")
		: [];
	// Dedup by name: project shadows user.
	const seen = new Set<string>();
	const out: SlashCommand[] = [];
	for (const cmd of [...project, ...user]) {
		if (seen.has(cmd.name)) continue;
		seen.add(cmd.name);
		out.push(cmd);
	}
	out.sort((a, b) => {
		if (a.source !== b.source) return a.source === "project" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return out;
}

/** Convenience for the common case: project = vault root, user = $HOME. */
export function discoverSlashCommandsForVault(vaultRoot: string): Promise<SlashCommand[]> {
	let userRoot: string | null;
	try { userRoot = homedir() || null; } catch { userRoot = null; }
	return discoverSlashCommands({ projectRoot: vaultRoot, userRoot });
}

async function loadFromScope(rootDir: string, source: SlashCommandSource): Promise<SlashCommand[]> {
	let exists = false;
	try {
		const stat = await fsp.stat(rootDir);
		exists = stat.isDirectory();
	} catch {
		return [];
	}
	if (!exists) return [];
	const out: SlashCommand[] = [];
	await walk(rootDir, rootDir, source, out);
	return out.slice(0, MAX_COMMANDS_PER_SCOPE);
}

async function walk(
	rootDir: string,
	currentDir: string,
	source: SlashCommandSource,
	out: SlashCommand[],
): Promise<void> {
	let entries: import("fs").Dirent[];
	try {
		entries = await fsp.readdir(currentDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_COMMANDS_PER_SCOPE) return;
		const full = join(currentDir, entry.name);
		if (entry.isDirectory()) {
			await walk(rootDir, full, source, out);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		// Skip files larger than MAX_FILE_BYTES — those aren't templates,
		// they're docs the user dropped in by accident.
		try {
			const stat = await fsp.stat(full);
			if (stat.size > MAX_FILE_BYTES) continue;
		} catch {
			continue;
		}
		let content: string;
		try {
			content = await fsp.readFile(full, "utf8");
		} catch {
			continue;
		}
		const rel = relative(rootDir, full);
		const name = commandNameFromPath(rel.split(sep).join("/"));
		if (!name) continue;
		const fm = parseCommandFrontmatter(content);
		out.push({
			name,
			description: fm.description,
			argumentHint: fm.argumentHint,
			source,
			path: rel.split(sep).join("/"),
		});
	}
}
