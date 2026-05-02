import { App, MarkdownView, TFile } from "obsidian";
import { hashString } from "../utils/fs";

export interface CapturedContext {
	kind: "note" | "selection";
	path: string;
	content: string;
	contentHash: string;
	bytes: number;
	range?: [number, number];
	truncated?: { originalBytes: number };
}

export interface CaptureOptions {
	preferSelection: boolean;
	maxAttachKB: number;
}

/**
 * Capture the user's active note (or selection) for context injection.
 * Falls through these signals in order:
 *   1. The focused MarkdownView — gives us editor + selection state.
 *   2. Any open MarkdownView leaf (the sidebar itself is active when the user
 *      is talking to us, so the focused view is often us, not the note).
 *   3. `workspace.getActiveFile()` — last-touched file, regardless of focus.
 */
export async function captureActiveContext(
	app: App,
	opts: CaptureOptions
): Promise<CapturedContext | null> {
	// 1. A focused MarkdownView gives selection + cursor — best case.
	const focusedView = app.workspace.getActiveViewOfType(MarkdownView);
	if (focusedView?.file) {
		const ctx = await fromMarkdownView(app, focusedView, opts);
		if (ctx) return ctx;
	}

	// 2. Look for any visible MarkdownView leaf so a still-open editor wins
	//    over a stale "last active file" reference.
	const leaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of leaves) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file) {
			const ctx = await fromMarkdownView(app, view, opts);
			if (ctx) return ctx;
		}
	}

	// 3. Fallback: last-active file, even if no MarkdownView is currently open.
	const file = app.workspace.getActiveFile();
	if (file && isMarkdownLike(file)) {
		return fromFile(app, file, opts);
	}
	return null;
}

async function fromMarkdownView(
	app: App,
	view: MarkdownView,
	opts: CaptureOptions
): Promise<CapturedContext | null> {
	const file = view.file;
	if (!file) return null;
	const editor = view.editor;
	const selection = editor.getSelection();
	if (selection && opts.preferSelection) {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const truncated = truncate(selection, opts.maxAttachKB);
		return {
			kind: "selection",
			path: file.path,
			content: truncated.content,
			contentHash: hashString(`selection:${file.path}:${from.line}-${to.line}:${truncated.content}`),
			bytes: truncated.bytes,
			range: [from.line + 1, to.line + 1],
			truncated: truncated.truncated,
		};
	}
	return fromFile(app, file, opts);
}

async function fromFile(app: App, file: TFile, opts: CaptureOptions): Promise<CapturedContext> {
	const raw = await app.vault.cachedRead(file);
	const truncated = truncate(raw, opts.maxAttachKB);
	return {
		kind: "note",
		path: file.path,
		content: truncated.content,
		contentHash: hashString(`note:${file.path}:${truncated.content}`),
		bytes: truncated.bytes,
		truncated: truncated.truncated,
	};
}

function isMarkdownLike(file: TFile): boolean {
	return file.extension === "md" || file.extension === "markdown" || file.extension === "txt";
}

function truncate(input: string, maxKB: number): {
	content: string;
	bytes: number;
	truncated?: { originalBytes: number };
} {
	const max = Math.max(1, Math.floor(maxKB)) * 1024;
	const buf = Buffer.from(input, "utf8");
	if (buf.length <= max) return { content: input, bytes: buf.length };
	const slice = buf.subarray(0, max).toString("utf8");
	return {
		content: slice,
		bytes: max,
		truncated: { originalBytes: buf.length },
	};
}
