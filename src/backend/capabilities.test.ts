import { describe, expect, it } from "vitest";
import {
	isAgentBackend,
	isReasoningCapable,
	isReasoningSignatureCapable,
	isMcpCapable,
	isSubAgentCapable,
	isPlanModeCapable,
	isHooksCapable,
	isCompactionCapable,
} from "./capabilities";
import type { Backend, Capabilities } from "./types";

const baseCaps: Capabilities = {
	agentic: false,
	attachments: { image: false, file: false },
	resume: "replay",
	reasoning: false,
	reasoningSignature: false,
	mcp: false,
	slashCommands: false,
	hooks: false,
	subAgents: false,
	planMode: false,
	compaction: false,
	citations: false,
	cacheUsage: false,
	costTracking: false,
};

const fakeBackend = (caps: Partial<Capabilities>): Backend => {
	const merged: Capabilities = { ...baseCaps, ...caps };
	return {
		id: () => "claude-code",
		capabilities: () => merged,
		availableModels: async () => [],
		isAvailable: async () => true,
		version: async () => "0.0.0",
		authStatus: async () => ({ state: "signed_out" }) as const,
		createSession: async () => ({ id: "s" as never, backendId: "claude-code" }),
		listSessions: async () => [],
		getSession: async () => ({}) as never,
		renameSession: async () => undefined,
		deleteSession: async () => undefined,
		sendTurn: () => ({
			[Symbol.asyncIterator]: () => ({
				next: async () => ({ value: undefined, done: true }),
			}),
		}),
		abortTurn: async () => undefined,
		setModel: async () => undefined,
		diagnostics: () => ({
			[Symbol.asyncIterator]: () => ({
				next: async () => ({ value: undefined, done: true }),
			}),
		}),
		hasNativeContext: async () => false,
		getNativeAdapter: () => ({}),
	};
};

describe("capability type guards", () => {
	it("isAgentBackend tracks the agentic flag", () => {
		expect(isAgentBackend(fakeBackend({ agentic: false }))).toBe(false);
		expect(isAgentBackend(fakeBackend({ agentic: true }))).toBe(true);
	});

	it("isReasoningCapable tracks the reasoning flag", () => {
		expect(isReasoningCapable(fakeBackend({ reasoning: false }))).toBe(false);
		expect(isReasoningCapable(fakeBackend({ reasoning: true }))).toBe(true);
	});

	it("isReasoningSignatureCapable tracks reasoningSignature", () => {
		expect(
			isReasoningSignatureCapable(
				fakeBackend({ reasoning: true, reasoningSignature: false }),
			),
		).toBe(false);
		expect(
			isReasoningSignatureCapable(
				fakeBackend({ reasoning: true, reasoningSignature: true }),
			),
		).toBe(true);
	});

	it("isMcpCapable tracks mcp flag", () => {
		expect(isMcpCapable(fakeBackend({ mcp: false }))).toBe(false);
		expect(isMcpCapable(fakeBackend({ mcp: true }))).toBe(true);
	});

	it("isSubAgentCapable tracks subAgents flag", () => {
		expect(isSubAgentCapable(fakeBackend({ subAgents: false }))).toBe(false);
		expect(isSubAgentCapable(fakeBackend({ subAgents: true }))).toBe(true);
	});

	it("isPlanModeCapable tracks planMode flag", () => {
		expect(isPlanModeCapable(fakeBackend({ planMode: false }))).toBe(false);
		expect(isPlanModeCapable(fakeBackend({ planMode: true }))).toBe(true);
	});

	it("isHooksCapable tracks hooks flag", () => {
		expect(isHooksCapable(fakeBackend({ hooks: false }))).toBe(false);
		expect(isHooksCapable(fakeBackend({ hooks: true }))).toBe(true);
	});

	it("isCompactionCapable tracks compaction flag", () => {
		expect(isCompactionCapable(fakeBackend({ compaction: false }))).toBe(
			false,
		);
		expect(isCompactionCapable(fakeBackend({ compaction: true }))).toBe(true);
	});

	it("guards compose: a fully-capable backend passes every guard", () => {
		const b = fakeBackend({
			agentic: true,
			reasoning: true,
			reasoningSignature: true,
			mcp: true,
			subAgents: true,
			planMode: true,
			hooks: true,
			compaction: true,
		});
		expect(
			[
				isAgentBackend(b),
				isReasoningCapable(b),
				isReasoningSignatureCapable(b),
				isMcpCapable(b),
				isSubAgentCapable(b),
				isPlanModeCapable(b),
				isHooksCapable(b),
				isCompactionCapable(b),
			].every(Boolean),
		).toBe(true);
	});
});
