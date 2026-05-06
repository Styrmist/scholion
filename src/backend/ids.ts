export type BackendId =
	| "claude-code"
	| "codex"
	| "gemini-cli"
	| "copilot-cli"
	| "llama-http";

declare const sessionIdBrand: unique symbol;
export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };

declare const turnIdBrand: unique symbol;
export type TurnId = string & { readonly [turnIdBrand]: "TurnId" };

declare const permReqIdBrand: unique symbol;
export type PermReqId = string & { readonly [permReqIdBrand]: "PermReqId" };

export const sessionId = (s: string): SessionId => s as SessionId;
export const turnId = (s: string): TurnId => s as TurnId;
export const permReqId = (s: string): PermReqId => s as PermReqId;
