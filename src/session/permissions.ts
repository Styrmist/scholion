import { PermissionDecision, PermissionGrants } from "../types";

export function applyDecision(
	grants: PermissionGrants,
	tool: string,
	decision: PermissionDecision
): PermissionGrants {
	const next: PermissionGrants = {
		allowedTools: [...grants.allowedTools],
		deniedTools: [...grants.deniedTools],
		lastAttached: grants.lastAttached,
	};
	if (decision === "deny") {
		if (!next.deniedTools.includes(tool)) next.deniedTools.push(tool);
		next.allowedTools = next.allowedTools.filter((t) => t !== tool);
	} else {
		if (!next.allowedTools.includes(tool)) next.allowedTools.push(tool);
		next.deniedTools = next.deniedTools.filter((t) => t !== tool);
	}
	return next;
}

export function emptyGrants(allowedTools: string[]): PermissionGrants {
	return {
		allowedTools: [...allowedTools],
		deniedTools: [],
	};
}
