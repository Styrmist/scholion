import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type ClaudeCodePlugin from "../../main";
import { resolvePaths } from "./binary/paths";
import type { BinaryInstaller } from "./binary/installer";
import type { ClaudeRunner } from "./runner";
import type { AuthManager } from "./auth";
import type { HookServer } from "./permissions/hookServer";
import type { SessionStore, SessionRecord } from "../../session/store";
import { buildHookCommand } from "./permissions/hookCommandString";
import { buildSettingsJson } from "./settingsJson";
import { translateClaudeEvent } from "./eventTranslator";
import { AsyncQueue } from "./asyncQueue";
import { ClaudeSessionMap } from "./sessionMap";
import { ClaudeNativeAdapter } from "./nativeAdapter";
import { parseMcpServers } from "./mcpServers";
import { discoverSlashCommandsForVault } from "./slashCommands/discover";
import * as logger from "../../utils/log";
import type {
	AuthStatus,
	Capabilities,
	CreateSessionOptions,
	DiagnosticEvent,
	ModelInfo,
	NormalizedEvent,
	PermissionDecision,
	PermissionRule,
	SendTurnRequest,
	SessionMeta,
	SessionRef,
	SignInOptions,
	SlashCommandInfo,
	ToolInfo,
} from "../../backend/types";
import type {
	HookConfig,
	McpServerInfo,
	McpServerSpec,
	SubAgentInfo,
} from "../../backend/capabilities";
import type {
	BackendId,
	PermReqId,
	SessionId,
	TurnId,
} from "../../backend/ids";
import { sessionId as toSessionId } from "../../backend/ids";
import type { ClaudeFullSurface } from "./types";
import type { PermissionMode, StreamEvent } from "../../types";
import type { HookDecision } from "./permissions/hookProtocol";

const CLAUDE_MODELS: ModelInfo[] = [
	{
		id: "sonnet",
		displayName: "sonnet",
		description: "Latest Sonnet, everyday notes and writing",
	},
	{
		id: "opus",
		displayName: "opus",
		description: "Latest Opus, complex reasoning",
	},
	{
		id: "haiku",
		displayName: "haiku",
		description: "Fast / efficient, simple tasks",
	},
	{
		id: "opusplan",
		displayName: "opusplan",
		description: "Opus while planning, Sonnet while executing",
	},
];

const CLAUDE_TOOLS: ToolInfo[] = [
	{ name: "Read", risk: "read" },
	{ name: "Grep", risk: "read" },
	{ name: "Glob", risk: "read" },
	{ name: "Edit", risk: "write" },
	{ name: "Write", risk: "write" },
	{ name: "Bash", risk: "exec" },
	{ name: "WebFetch", risk: "network" },
	{ name: "WebSearch", risk: "network" },
	{ name: "Task", risk: "exec" },
];

const CAPS: Capabilities = {
	agentic: true,
	attachments: { image: true, file: true },
	resume: "native",
	reasoning: true,
	reasoningSignature: true,
	mcp: true,
	slashCommands: true,
	hooks: true,
	subAgents: true,
	planMode: true,
	compaction: true,
	citations: true,
	cacheUsage: true,
	costTracking: true,
};

export interface ClaudeBackendDeps {
	runner: ClaudeRunner;
	auth: AuthManager;
	hookServer: HookServer;
	installer: BinaryInstaller;
	sessions: SessionStore;
}

export class ClaudeCodeBackend implements ClaudeFullSurface {
	private readonly sessionMap = new ClaudeSessionMap();
	private readonly nativeAdapter: ClaudeNativeAdapter;

	constructor(
		private readonly plugin: ClaudeCodePlugin,
		private readonly deps: ClaudeBackendDeps,
	) {
		this.nativeAdapter = new ClaudeNativeAdapter(
			deps.auth,
			deps.hookServer,
			deps.installer,
		);
	}

	id(): BackendId {
		return "claude-code";
	}

	capabilities(): Capabilities {
		return CAPS;
	}

	async availableModels(): Promise<ModelInfo[]> {
		return CLAUDE_MODELS;
	}

	async availableTools(): Promise<ToolInfo[]> {
		return CLAUDE_TOOLS;
	}

	async isAvailable(): Promise<boolean> {
		const v = await this.deps.installer.getInstalledVersion();
		return v !== null;
	}

	async version(): Promise<string> {
		return (await this.deps.installer.getInstalledVersion()) ?? "";
	}

	async install(): Promise<void> {
		await this.deps.installer.install();
	}

	async update(): Promise<void> {
		await this.deps.installer.update();
	}

	async authStatus(): Promise<AuthStatus> {
		const ok = await this.deps.auth.isAuthenticated();
		if (!ok) return { state: "signed_out" };
		const email = this.deps.auth.getSignedInEmail();
		return {
			state: "signed_in",
			...(email && { account: { email } }),
		};
	}

	async signIn(_opts?: SignInOptions): Promise<void> {
		// Login is event-driven via AuthManager.beginLogin(events). The facade
		// signature is fire-and-forget; UI uses the native adapter for the
		// phase callbacks during transition.
		await this.deps.auth.beginLogin({
			onPhase: () => {
				/* no-op; UI listens via the AuthManager directly during transition */
			},
		});
	}

	async signOut(): Promise<void> {
		await this.deps.auth.logout();
	}

	async setApiKey(_key: string): Promise<void> {
		throw new Error(
			"claude-code does not support API key auth; use signIn() with subscription",
		);
	}

	async clearApiKey(): Promise<void> {
		throw new Error(
			"claude-code does not support API key auth; use signOut() with subscription",
		);
	}

	async createSession(opts: CreateSessionOptions): Promise<SessionRef> {
		const localId = generateLocalId();
		const paths = resolvePaths(this.plugin);
		const meta: SessionMeta = {
			localId,
			title: opts.title ?? "New chat",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: opts.cwd ?? paths.vaultRoot,
			...(opts.model && { model: opts.model }),
		};
		const record: SessionRecord = {
			meta,
			turns: [],
			permissions: { allowedTools: [], deniedTools: [] },
		};
		await this.deps.sessions.saveImmediate(record);
		const sid = toSessionId(localId);
		this.sessionMap.upsert(sid, {
			cwd: meta.cwd,
			...(opts.model && { model: opts.model }),
			permissionMode: this.plugin.settings.permissionMode,
		});
		return { id: sid, backendId: "claude-code" };
	}

	async listSessions(): Promise<SessionMeta[]> {
		return this.deps.sessions.list();
	}

	async getSession(id: SessionId): Promise<SessionRecord> {
		const record = await this.deps.sessions.load(id as string);
		if (!record) throw new Error(`Session ${id} not found`);
		return record;
	}

	async renameSession(id: SessionId, title: string): Promise<void> {
		const record = await this.getSession(id);
		record.meta.title = title;
		record.meta.updatedAt = Date.now();
		await this.deps.sessions.saveImmediate(record);
	}

	async deleteSession(id: SessionId): Promise<void> {
		await this.deps.sessions.delete(id as string);
		this.sessionMap.delete(id);
	}

	sendTurn(req: SendTurnRequest): AsyncIterable<NormalizedEvent> {
		const queue = new AsyncQueue<NormalizedEvent>();
		void this.runTurn(req, queue);
		return queue;
	}

	private async runTurn(
		req: SendTurnRequest,
		queue: AsyncQueue<NormalizedEvent>,
	): Promise<void> {
		try {
			const record = await this.getSession(req.sessionId);
			const ctx = this.sessionMap.getOrInit(req.sessionId, () => ({
				cwd: record.meta.cwd,
				...(record.meta.model && { model: record.meta.model }),
				permissionMode: this.plugin.settings.permissionMode,
			}));
			// One-shot bootstrap: if the session record carries the legacy native id
			// (pre-migration), surface it into the session map so resume works.
			if (!ctx.nativeId && record.meta.id) {
				this.sessionMap.upsert(req.sessionId, { nativeId: record.meta.id });
			}
			const sessionRecord = record;
			const onDiagnostic = req.onDiagnostic;
			const signal = req.signal;
			const paths = resolvePaths(this.plugin);
			const permMode: PermissionMode =
				req.options?.model && req.options?.model.includes("plan")
					? "plan"
					: ctx.permissionMode;
			const settingsJson = buildSettingsJson({
				permissionMode: permMode,
				configDir: this.plugin.app.vault.configDir,
				hookCommand: buildHookCommand(paths.hookScriptPath),
			});
			const promptText =
				typeof req.content === "string"
					? req.content
					: req.content
							.filter((c) => c.type === "text")
							.map((c) => (c as { type: "text"; text: string }).text)
							.join("\n");
			const controller = new AbortController();
			if (signal) {
				if (signal.aborted) controller.abort();
				else signal.addEventListener("abort", () => controller.abort(), { once: true });
			}
			void this.deps.runner
				.send({
					prompt: promptText,
					cwd: ctx.cwd || paths.vaultRoot,
					binaryPath: paths.binaryPath,
					configDir: paths.configDir,
					...(this.sessionMap.get(req.sessionId)?.nativeId && {
						resumeSessionId: this.sessionMap.get(req.sessionId)!.nativeId!,
					}),
					permissionMode: permMode,
					...((req.options?.model ?? ctx.model) && {
						model: req.options?.model ?? ctx.model,
					}),
					...((req.options?.systemPromptAddendum ??
						this.plugin.settings.systemPromptAddendum) && {
						systemPromptAddendum:
							req.options?.systemPromptAddendum ??
							this.plugin.settings.systemPromptAddendum,
					}),
					settingsJson,
					signal: controller.signal,
					onEvent: (e: StreamEvent) => {
						const out = translateClaudeEvent(e);
						if (out.nativeSessionId) {
							this.sessionMap.upsert(req.sessionId, {
								nativeId: out.nativeSessionId,
							});
							// Double-write: until UI fully migrates off
							// SessionMeta.id (Stage 7), keep it in sync so legacy
							// !record.meta.id checks still resolve correctly.
							if (!sessionRecord.meta.id) {
								sessionRecord.meta.id = out.nativeSessionId;
							}
						}
						for (const ev of out.events) queue.push(ev);
						if (onDiagnostic) {
							for (const d of out.diagnostics) onDiagnostic(d);
						}
					},
				})
				.then(() => queue.close())
				.catch((err) => queue.error(err));
		} catch (err) {
			queue.error(err);
		}
	}

	async abortTurn(_id: TurnId): Promise<void> {
		this.deps.runner.killAll();
	}

	async setModel(id: SessionId, modelId: string): Promise<void> {
		const record = await this.getSession(id);
		record.meta.model = modelId;
		record.meta.updatedAt = Date.now();
		this.sessionMap.upsert(id, { model: modelId });
		await this.deps.sessions.saveImmediate(record);
	}

	async setSystemPrompt(
		id: SessionId,
		text: string | null,
	): Promise<void> {
		this.sessionMap.upsert(id, {
			systemPromptAddendum: text ?? undefined,
		});
	}

	diagnostics(_id: SessionId): AsyncIterable<DiagnosticEvent> {
		// v1: the hot path is CoordinatorEvents.onDiagnostic. This AsyncIterable
		// is a no-op pass-through so the interface contract holds (TODO.md).
		const empty = new AsyncQueue<DiagnosticEvent>();
		empty.close();
		return empty;
	}

	async hasNativeContext(id: SessionId): Promise<boolean> {
		return this.sessionMap.hasNativeId(id);
	}

	getNativeAdapter(): ClaudeNativeAdapter {
		return this.nativeAdapter;
	}

	// === AgentBackend ===

	async setCwd(id: SessionId, path: string): Promise<void> {
		const record = await this.getSession(id);
		record.meta.cwd = path;
		this.sessionMap.upsert(id, { cwd: path });
		await this.deps.sessions.saveImmediate(record);
	}

	async getCwd(id: SessionId): Promise<string> {
		const ctx = this.sessionMap.get(id);
		if (ctx?.cwd) return ctx.cwd;
		const record = await this.getSession(id);
		return record.meta.cwd;
	}

	setPermissionPolicy(rule: PermissionRule): void {
		// Session-scoped rules require an active record; UI calls this during a
		// turn and the coordinator owns the record. For now, mutate global
		// settings for "global" scope; "session" scope is a no-op until Stage 5
		// wires it through the active record. The escalation flow uses the
		// session record's allowedTools/deniedTools list directly.
		if (rule.scope !== "global") return;
		const target =
			rule.mode === "allow"
				? this.plugin.settings.allowedTools
				: this.plugin.settings.disallowedTools;
		if (!target.includes(rule.tool)) target.push(rule.tool);
		void this.plugin.saveSettings();
	}

	removePermissionPolicy(rule: PermissionRule): void {
		if (rule.scope !== "global") return;
		const target =
			rule.mode === "allow"
				? this.plugin.settings.allowedTools
				: this.plugin.settings.disallowedTools;
		const idx = target.indexOf(rule.tool);
		if (idx >= 0) target.splice(idx, 1);
		void this.plugin.saveSettings();
	}

	async resolvePermission(
		reqId: PermReqId,
		decision: PermissionDecision,
	): Promise<void> {
		const hookDecision = mapPermissionDecisionToHook(decision);
		this.deps.hookServer.respond(reqId as string, hookDecision);
	}

	async discoverSlashCommands(_id: SessionId): Promise<SlashCommandInfo[]> {
		const paths = resolvePaths(this.plugin);
		const list = await discoverSlashCommandsForVault(paths.vaultRoot);
		return list.map((c) => ({
			name: c.name,
			...(c.description !== undefined && { description: c.description }),
			...(c.argumentHint !== undefined && { argumentHint: c.argumentHint }),
			source: c.source,
			path: c.path,
		}));
	}

	// === McpCapable ===

	async listMcpServers(): Promise<McpServerInfo[]> {
		const paths = resolvePaths(this.plugin);
		const userJson = readJsonOrEmpty(join(paths.configDir, ".claude.json"));
		const projectJson = readJsonOrEmpty(
			join(paths.vaultRoot, ".mcp.json"),
		);
		const userServers = parseMcpServers(userJson);
		const projectServers = parseMcpServers(projectJson);
		const seen = new Set<string>();
		const out: McpServerInfo[] = [];
		for (const s of [...projectServers, ...userServers]) {
			if (seen.has(s.name)) continue;
			seen.add(s.name);
			out.push({
				name: s.name,
				transport:
					s.transport === "stdio" || s.transport === "http" || s.transport === "sse"
						? s.transport
						: "stdio",
				summary: s.summary,
				disabled: s.disabled,
			});
		}
		return out;
	}

	async addMcpServer(_spec: McpServerSpec): Promise<void> {
		throw new Error("addMcpServer not implemented in v1; see TODO.md");
	}

	async removeMcpServer(_name: string): Promise<void> {
		throw new Error("removeMcpServer not implemented in v1; see TODO.md");
	}

	// === HooksCapable ===

	async getHookConfig(): Promise<HookConfig> {
		// We use hooks for permissions internally (PreToolUse hook script). User-
		// facing hook config is not exposed in the plugin (TODO.md).
		return { commands: {} };
	}

	async setHookConfig(_cfg: HookConfig): Promise<void> {
		throw new Error("setHookConfig not exposed: managed by PreToolUse hook");
	}

	// === SubAgentCapable ===

	async listSubAgents(): Promise<SubAgentInfo[]> {
		// Could walk .claude/agents/*.md (TODO.md). For now, empty.
		return [];
	}

	// === PlanModeCapable ===

	setPlanMode(id: SessionId, on: boolean): void {
		this.sessionMap.upsert(id, {
			permissionMode: on ? "plan" : "default",
		});
	}

	async resolvePlanModeExit(
		_reqId: string,
		_decision: "approve" | "keepPlanning",
	): Promise<void> {
		throw new Error(
			"resolvePlanModeExit not yet wired in UI; see TODO.md",
		);
	}

	// === ReasoningSignatureCapable ===

	verifyReasoningBlock(_blockId: string, _sig: string): boolean {
		// Defer real signature verification until reasoning UI lands (TODO.md).
		return true;
	}

	// === CompactionCapable ===

	async triggerCompaction(_id: SessionId): Promise<void> {
		throw new Error("compaction is managed internally by claude-code");
	}
}

function readJsonOrEmpty(path: string): string {
	if (!existsSync(path)) return "{}";
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		logger.warn("readJsonOrEmpty failed", { path, error: e });
		return "{}";
	}
}

function generateLocalId(): string {
	const buf = new Uint8Array(8);
	if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
		crypto.getRandomValues(buf);
	} else {
		for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(buf)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function mapPermissionDecisionToHook(
	d: PermissionDecision,
): HookDecision {
	switch (d) {
		case "deny":
			return "deny";
		case "allowOnce":
		case "allowSession":
		case "allowAlways":
			return "allow";
	}
}
