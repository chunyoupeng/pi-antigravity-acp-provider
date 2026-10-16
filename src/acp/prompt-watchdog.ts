import type { SessionNotification } from "@agentclientprotocol/sdk";

/** Progress, not total turn duration, bounds a prompt. Outstanding work gets
 * a longer but still finite inactivity window; a lost tool update cannot hang forever. */
export class PromptWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stallTimer: ReturnType<typeof setTimeout> | undefined;
	private stallAbortTimer: ReturnType<typeof setTimeout> | undefined;
	private stallWarned = false;
	private holds = 0;
	private permissions = 0;
	private readonly tools = new Set<string>();
	private disposed = false;
	private fired = false;

	constructor(
		private readonly idleMs: number,
		private readonly workIdleMs: number,
		private readonly onTimeout: (busy: boolean, timeoutMs: number) => void,
		private readonly stallWarnMs?: number,
		private readonly onStall?: (busy: boolean, silentMs: number, abortInMs?: number) => void,
		private readonly stallAbortMs?: number,
	) {
		for (const value of [idleMs, workIdleMs]) {
			if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
				throw new RangeError("Prompt inactivity timeouts must be positive finite timer durations");
			}
		}
		for (const [label, value] of [["stall warning", stallWarnMs], ["stall abort", stallAbortMs]] as const) {
			if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)) {
				throw new RangeError(`Prompt ${label} must be a positive finite timer duration`);
			}
		}
		if (stallWarnMs !== undefined && stallAbortMs !== undefined && stallWarnMs + stallAbortMs > 2_147_483_647) {
			throw new RangeError("Prompt stall warning plus abort must fit a timer duration");
		}
	}

	arm(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.stallTimer) clearTimeout(this.stallTimer);
		if (this.stallAbortTimer) clearTimeout(this.stallAbortTimer);
		this.timer = this.stallTimer = this.stallAbortTimer = undefined;
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
		if (this.onStall && this.stallWarnMs !== undefined && !this.stallWarned && this.stallWarnMs < duration) {
			const silentMs = this.stallWarnMs;
			this.stallTimer = setTimeout(() => {
				this.stallTimer = undefined;
				if (this.disposed || this.fired || this.stallWarned) return;
				this.stallWarned = true;
				// Outstanding tool/permission work can legitimately stay mute; only
				// an idle backend gets aborted once the grace period also expires.
				const abortMs = !busy && this.stallAbortMs !== undefined ? this.stallAbortMs : undefined;
				if (abortMs === undefined) {
					this.onStall?.(busy, silentMs);
					return;
				}
				this.onStall?.(busy, silentMs, abortMs);
				this.stallAbortTimer = setTimeout(() => {
					this.stallAbortTimer = undefined;
					if (this.disposed || this.fired) return;
					this.fired = true;
					this.onTimeout(false, silentMs + abortMs);
				}, abortMs);
				this.stallAbortTimer.unref?.();
			}, silentMs);
			this.stallTimer.unref?.();
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
		this.stallWarned = false;
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
		if (this.stallTimer) clearTimeout(this.stallTimer);
		if (this.stallAbortTimer) clearTimeout(this.stallAbortTimer);
		this.timer = this.stallTimer = this.stallAbortTimer = undefined;
		this.stallWarned = false;
		this.tools.clear();
		this.holds = this.permissions = 0;
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
