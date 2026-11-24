import type { SessionNotification } from "@agentclientprotocol/sdk";

/** Progress, not total turn duration, bounds a prompt. Outstanding work gets
 * a longer but still finite inactivity window; a lost tool update cannot hang forever. */
export class PromptWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stallAbortTimer: ReturnType<typeof setTimeout> | undefined;
	private holds = 0;
	private permissions = 0;
	private readonly tools = new Set<string>();
	private disposed = false;
	private fired = false;

	constructor(
		private readonly idleMs: number,
		private readonly workIdleMs: number,
		private readonly onTimeout: (busy: boolean, timeoutMs: number) => void,
		private readonly stallAbortMs?: number,
		private readonly upstreamActive?: () => boolean,
	) {
		for (const value of [idleMs, workIdleMs]) {
			if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
				throw new RangeError("Prompt inactivity timeouts must be positive finite timer durations");
			}
		}
		if (stallAbortMs !== undefined && (!Number.isFinite(stallAbortMs) || stallAbortMs <= 0 || stallAbortMs > 2_147_483_647)) {
			throw new RangeError("Prompt stall abort must be a positive finite timer duration");
		}
	}

	arm(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.stallAbortTimer) clearTimeout(this.stallAbortTimer);
		this.timer = this.stallAbortTimer = undefined;
		if (this.disposed || this.fired) return;
		const busy = this.holds > 0 || this.permissions > 0 || this.tools.size > 0;
		const duration = busy ? this.workIdleMs : this.idleMs;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || this.fired) return;
			this.fired = true;
			this.onTimeout(busy, duration);
		}, duration);
		this.timer.unref?.();
		// Outstanding tool/permission work can legitimately stay mute; only
		// an idle backend gets aborted early when upstream inference is not active.
		if (!busy && this.stallAbortMs !== undefined && this.stallAbortMs < duration) {
			this.scheduleStallAbort(this.stallAbortMs, this.stallAbortMs);
		}
	}

	noteUpdate(notification: SessionNotification): void {
		if (this.disposed || this.fired) return;
		const update = notification.update;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (update.status === "completed" || update.status === "failed") this.tools.delete(update.toolCallId);
			else if (update.sessionUpdate === "tool_call" || update.status === "pending" || update.status === "in_progress") {
				this.tools.add(update.toolCallId);
			}
		}
		this.arm();
	}

	hold(): () => void {
		return this.acquire("holds");
	}

	beginPermission(): () => void {
		return this.acquire("permissions");
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.stallAbortTimer) clearTimeout(this.stallAbortTimer);
		this.timer = this.stallAbortTimer = undefined;
		this.tools.clear();
		this.holds = this.permissions = 0;
	}

	private scheduleStallAbort(silentMs: number, stepMs: number): void {
		this.stallAbortTimer = setTimeout(() => {
			this.stallAbortTimer = undefined;
			if (this.disposed || this.fired) return;
			// Active upstream inference (including pre-first-chunk tool-call generation)
			// is real progress that Antigravity has not relayed over ACP yet.
			if (this.upstreamActive?.()) {
				this.scheduleStallAbort(silentMs + stepMs, stepMs);
				return;
			}
			this.fired = true;
			this.onTimeout(false, silentMs);
		}, stepMs);
		this.stallAbortTimer.unref?.();
	}

	private acquire(kind: "holds" | "permissions"): () => void {
		if (this.disposed || this.fired) return () => undefined;
		this[kind] += 1;
		this.arm();
		let released = false;
		return () => {
			if (released || this.disposed || this.fired) return;
			released = true;
			this[kind] -= 1;
			this.arm();
		};
	}
}
