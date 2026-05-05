/**
 * Pure decision helpers extracted from TurnCoordinator.
 *
 * These cover the branchy parts of the same-tool batching and per-turn
 * tool-use-cap logic so the state-machine in TurnCoordinator can focus on
 * sequencing while the predicates below stay independently testable.
 */

export interface QueuedPermission {
	toolUseId: string;
	toolName: string;
}

/**
 * Split a permission queue into (a) tool_use_ids whose tool name matches the
 * primary and (b) the remaining entries to keep queued. Order is preserved
 * within each side. Used by `openPermissionPrompt` to drain same-tool siblings
 * into the active prompt batch.
 */
export function partitionQueueByTool(
	queue: ReadonlyArray<QueuedPermission>,
	tool: string,
): { matching: string[]; remaining: QueuedPermission[] } {
	const matching: string[] = [];
	const remaining: QueuedPermission[] = [];
	for (const entry of queue) {
		if (entry.toolName === tool) matching.push(entry.toolUseId);
		else remaining.push(entry);
	}
	return { matching, remaining };
}

/**
 * When a hook fires while a permission prompt is already open, decide whether
 * the new tool can merge into the active prompt as a batched sibling.
 *
 * Same-tool merge is only safe while NO cycle-cap pause is in flight — the
 * cycle-cap UI takes precedence and we don't want a fresh sibling silently
 * piling onto a prompt the user hasn't seen yet.
 */
export function shouldBatchSameTool(
	pendingTool: string,
	newToolName: string,
	cycleCapHeld: boolean,
): boolean {
	if (cycleCapHeld) return false;
	return pendingTool === newToolName;
}

/**
 * Decide whether a fresh hook arrival should trigger the per-turn tool-use cap.
 *
 * - `cap <= 0` is disabled.
 * - `alreadyHeld` short-circuits to false to avoid double-prompting when a
 *   cycle-cap UI is already showing.
 * - The check is `count > cap` (not `>=`): the user explicitly opts in to
 *   exactly `cap` calls per cycle, then the next one trips the prompt.
 */
export function shouldPauseForCycleCap(
	count: number,
	cap: number,
	alreadyHeld: boolean,
): boolean {
	if (alreadyHeld) return false;
	if (cap <= 0) return false;
	return count > cap;
}
