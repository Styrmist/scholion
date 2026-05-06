import { buildSafetyDenyRules, HOOK_OUTER_TIMEOUT_SEC } from "../../constants";
import { PermissionMode } from "../../types";

export interface BuildSettingsArgs {
	permissionMode: PermissionMode;
	configDir: string;
	/** Single-string command the CLI will exec for each PreToolUse hook. */
	hookCommand: string;
	/** Outer ceiling in seconds; the CLI fails OPEN past this — script's inner timeout fails DENY first. */
	hookTimeoutSec?: number;
}

export function buildSettingsJson(args: BuildSettingsArgs): string {
	const settings = {
		permissions: {
			deny: buildSafetyDenyRules(args.configDir),
		},
		permission_mode: args.permissionMode,
		hooks: {
			PreToolUse: [
				{
					matcher: "*",
					hooks: [
						{
							type: "command",
							command: args.hookCommand,
							timeout: args.hookTimeoutSec ?? HOOK_OUTER_TIMEOUT_SEC,
						},
					],
				},
			],
		},
	};
	return JSON.stringify(settings);
}
