import type { AuthManager } from "./auth";
import type { HookServer } from "./permissions/hookServer";
import type { BinaryInstaller } from "./binary/installer";
import type { PluginPaths } from "./binary/paths";

// Power-user knobs and Claude-specific concepts the UI does not import
// directly. Returned from Backend.getNativeAdapter(). Anything in here is
// inherently provider-specific: code that reaches in here through a cast
// is opting in to coupling and must be gated on `backend.id() === 'claude-code'`.
export class ClaudeNativeAdapter {
	constructor(
		private readonly auth: AuthManager,
		private readonly hookServer: HookServer,
		private readonly installer: BinaryInstaller,
	) {}

	paths(): PluginPaths {
		return this.installer.paths;
	}

	hookServerHandle(): HookServer {
		return this.hookServer;
	}

	getSignedInEmail(): string | null {
		return this.auth.getSignedInEmail();
	}

	// Hooks for power-user features deferred from Group D (see TODO.md).
	setThinkingBudget(_tokens: number): void {
		// Not yet wired through to the CLI's --thinking-budget flag.
	}
}
