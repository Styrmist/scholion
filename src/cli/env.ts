import { HOOK_INNER_TIMEOUT_MS } from "../constants";

export interface IsolatedEnvOptions {
	configDir: string;
	/** Hook IPC dir (system temp, per-vault); the hook script reads/writes here. */
	tmpDir: string;
	/** Extra env vars to set on the child (e.g. ELECTRON_RUN_AS_NODE=1). */
	extras?: Record<string, string>;
}

/**
 * Build a process env that forces subscription OAuth via CLAUDE_CONFIG_DIR
 * and strips anything that could re-route auth (API keys, OAuth tokens,
 * cloud-provider credentials, custom base URLs, etc.).
 *
 * The strip list is conservative: anything that even *could* alter where
 * the CLI sends requests, what credentials it presents, or which provider
 * it talks to is removed before spawn. Re-audit after each Claude Code
 * release — see https://code.claude.com/docs/en/env-vars for the
 * authoritative current list.
 */
export function buildIsolatedEnv(opts: IsolatedEnvOptions): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };

	// Prefixes whose entire namespace can redirect auth or routing.
	const stripPrefixes = [
		"ANTHROPIC_",          // API key, base URL, custom headers, betas, default-model overrides, Bedrock/Vertex/Foundry settings
		"CLAUDE_CODE_USE_",    // provider toggles (Bedrock/Vertex/Foundry/PowerShell — last is benign but cheap to drop)
		"CLAUDE_CODE_OAUTH_",  // OAUTH_TOKEN, OAUTH_REFRESH_TOKEN, OAUTH_SCOPES — alternate identities
		"CLAUDE_CODE_SKIP_",   // SKIP_BEDROCK_AUTH, SKIP_VERTEX_AUTH, SKIP_FOUNDRY_AUTH, SKIP_MANTLE_AUTH
		"CLAUDE_CODE_CLIENT_", // CLIENT_CERT, CLIENT_KEY, CLIENT_KEY_PASSPHRASE — mTLS that could front a proxy
		"CLAUDE_CODE_CERT_",   // CERT_STORE — custom CA trust
		"AWS_",                // Bedrock credential chain (access key, profile, session token, bearer token, etc.)
		"AZURE_",              // Foundry credential chain
		"GOOGLE_",             // Vertex / GCP credential chain (GOOGLE_APPLICATION_CREDENTIALS etc.)
		"GCLOUD_",             // gcloud SDK config
	];

	// Exact matches outside those prefixes.
	const stripExact = new Set([
		"CLAUDE_CODE_API_KEY",                  // legacy API key alternative
		"CLAUDE_CODE_API_KEY_HELPER_TTL_MS",    // tied to apiKeyHelper which we don't allow
		"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", // platform-injected provider routing hint
		"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",     // we are the parent; we control scrubbing ourselves
	]);

	for (const key of Object.keys(env)) {
		if (stripExact.has(key) || stripPrefixes.some((p) => key.startsWith(p))) {
			delete env[key];
		}
	}

	env.CLAUDE_CONFIG_DIR = opts.configDir;
	env.DISABLE_AUTOUPDATER = "1";
	env.NO_COLOR = "1";
	// Forwarded to the PreToolUse hook child process via env inheritance.
	env.OBSIDIAN_CC_TMP_DIR = opts.tmpDir;
	env.OBSIDIAN_CC_HOOK_TIMEOUT_MS = String(HOOK_INNER_TIMEOUT_MS);
	if (opts.extras) {
		for (const [k, v] of Object.entries(opts.extras)) env[k] = v;
	}
	return env;
}
