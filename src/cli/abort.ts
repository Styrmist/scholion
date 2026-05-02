import { ChildProcess } from "child_process";
import { ABORT_GRACE_MS } from "../constants";

export interface AbortHandle {
	dispose: () => void;
}

export function wireAbort(child: ChildProcess, signal: AbortSignal): AbortHandle {
	let killTimer: ReturnType<typeof setTimeout> | null = null;
	const clearKillTimer = () => {
		if (killTimer !== null) {
			clearTimeout(killTimer);
			killTimer = null;
		}
	};

	const sendInterrupt = () => {
		try {
			if (process.platform === "win32") child.kill();
			else child.kill("SIGINT");
		} catch { /* ignore */ }
		clearKillTimer();
		killTimer = setTimeout(() => {
			killTimer = null;
			try { child.kill("SIGKILL"); } catch { /* ignore */ }
		}, ABORT_GRACE_MS);
	};

	const onChildExit = () => clearKillTimer();
	child.once("exit", onChildExit);
	child.once("error", onChildExit);

	if (signal.aborted) {
		sendInterrupt();
		return { dispose: clearKillTimer };
	}

	const onAbort = () => sendInterrupt();
	signal.addEventListener("abort", onAbort);
	return {
		dispose: () => {
			signal.removeEventListener("abort", onAbort);
			clearKillTimer();
		},
	};
}
