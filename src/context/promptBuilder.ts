import { CapturedContext } from "./activeNote";

export interface BuildPromptArgs {
	userText: string;
	context: CapturedContext | null;
}

export function buildPrompt(args: BuildPromptArgs): string {
	const sections: string[] = [];
	if (args.context) sections.push(serializeContext(args.context));
	sections.push(`<user_message>\n${args.userText}\n</user_message>`);
	return sections.join("\n\n");
}

function serializeContext(ctx: CapturedContext): string {
	const escapedPath = escapeXmlAttr(ctx.path);
	const range = ctx.range ? ` lines="${ctx.range[0]}-${ctx.range[1]}"` : "";
	const truncated = ctx.truncated
		? `\n  <truncated original_bytes="${ctx.truncated.originalBytes}"/>`
		: "";
	const safeContent = escapeContentBody(ctx.content);
	return [
		`<obsidian_active_note path="${escapedPath}" kind="${ctx.kind}"${range}>`,
		`  <content>`,
		safeContent,
		`  </content>${truncated}`,
		`</obsidian_active_note>`,
	].join("\n");
}

function escapeContentBody(content: string): string {
	// Prevent the model's parser from seeing a stray closing tag if the note
	// body contains literal "</content>" or "</obsidian_active_note>".
	return content
		.replace(/<\/content>/gi, "<\\/content>")
		.replace(/<\/obsidian_active_note>/gi, "<\\/obsidian_active_note>");
}

function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function shouldAttach(
	context: CapturedContext | null,
	previousHash: string | undefined
): boolean {
	if (!context) return false;
	if (!previousHash) return true;
	return previousHash !== context.contentHash;
}
