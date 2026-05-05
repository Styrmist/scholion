import { CapturedContext } from "./activeNote";

export interface BuildPromptArgs {
	userText: string;
	context: CapturedContext | null;
	/**
	 * Notes the user explicitly referenced via `@[[Name]]` syntax. Serialized
	 * as `<obsidian_mentioned_note>` blocks so the model can distinguish them
	 * from the implicit active-note attachment. Empty / undefined when no
	 * mentions resolved.
	 */
	mentions?: ReadonlyArray<CapturedContext>;
	/**
	 * Pre-rendered transcript of inherited turns (typically from a forked
	 * parent session). Wrapped in a `<previous_conversation>` block so the
	 * model knows it's prior context, not a fresh user message. Caller is
	 * responsible for keeping this within their byte budget.
	 */
	inheritedConversation?: string;
}

export function buildPrompt(args: BuildPromptArgs): string {
	const sections: string[] = [];
	if (args.inheritedConversation && args.inheritedConversation.trim()) {
		sections.push(serializeInheritedConversation(args.inheritedConversation));
	}
	if (args.context) sections.push(serializeActiveNote(args.context));
	for (const mention of args.mentions ?? []) {
		sections.push(serializeMention(mention));
	}
	sections.push(`<user_message>\n${args.userText}\n</user_message>`);
	return sections.join("\n\n");
}

function serializeInheritedConversation(body: string): string {
	const safe = body.replace(/<\/previous_conversation>/gi, "<\\/previous_conversation>");
	return `<previous_conversation>\n${safe}\n</previous_conversation>`;
}

function serializeActiveNote(ctx: CapturedContext): string {
	return serializeAs("obsidian_active_note", ctx);
}

function serializeMention(ctx: CapturedContext): string {
	return serializeAs("obsidian_mentioned_note", ctx);
}

function serializeAs(tag: string, ctx: CapturedContext): string {
	const escapedPath = escapeXmlAttr(ctx.path);
	const range = ctx.range ? ` lines="${ctx.range[0]}-${ctx.range[1]}"` : "";
	const truncated = ctx.truncated
		? `\n  <truncated original_bytes="${ctx.truncated.originalBytes}"/>`
		: "";
	const safeContent = escapeContentBody(ctx.content, tag);
	return [
		`<${tag} path="${escapedPath}" kind="${ctx.kind}"${range}>`,
		`  <content>`,
		safeContent,
		`  </content>${truncated}`,
		`</${tag}>`,
	].join("\n");
}

function escapeContentBody(content: string, outerTag: string): string {
	// Prevent the model's parser from seeing a stray closing tag if the note
	// body contains literal "</content>" or the outer tag's literal closer.
	const closer = new RegExp(`<\\/${outerTag}>`, "gi");
	return content
		.replace(/<\/content>/gi, "<\\/content>")
		.replace(closer, `<\\/${outerTag}>`);
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
