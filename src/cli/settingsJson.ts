import { buildSafetyDenyRules } from "../constants";
import { PermissionMode } from "../types";

export interface BuildSettingsArgs {
	permissionMode: PermissionMode;
	configDir: string;
}

export function buildSettingsJson(args: BuildSettingsArgs): string {
	const settings = {
		permissions: {
			deny: buildSafetyDenyRules(args.configDir),
		},
		permission_mode: args.permissionMode,
	};
	return JSON.stringify(settings);
}
