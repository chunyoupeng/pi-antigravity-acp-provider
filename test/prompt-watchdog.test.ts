import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptWatchdog } from "../src/acp/prompt-watchdog.js";

afterEach(() => vi.useRealTimers());
function watchdog() {
	vi.useFakeTimers();
	const timeout = vi.fn();
	const watch = new PromptWatchdog(100, 1000, timeout);
	watch.arm();
	return { watch, timeout };
}
const update: SessionNotification = { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progress" } } };
const tool = (status: "in_progress" | "completed" | "failed"): SessionNotification => ({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "t", status } });

describe("bounded prompt progress watchdog", () => {
	it("allows streaming beyond the former absolute deadline", () => {
		const { watch, timeout } = watchdog();
		for (let i = 0; i < 30; i++) { vi.advanceTimersByTime(90); watch.noteUpdate(update); }
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 100);
		watch.dispose();
	});

	it.each(["hold", "beginPermission"] as const)("gives %s a longer finite inactivity budget", (kind) => {
		const { watch, timeout } = watchdog();
		const release = watch[kind]();
		vi.advanceTimersByTime(999);
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(true, 1000);
		release(); watch.noteUpdate(update); vi.advanceTimersByTime(5000);
		expect(timeout).toHaveBeenCalledTimes(1);
		watch.dispose();
	});

	it.each(["completed", "failed"] as const)("tracks update-first native tools until %s", (status) => {
		const { watch, timeout } = watchdog();
		watch.noteUpdate(tool("in_progress"));
		vi.advanceTimersByTime(500);
		expect(timeout).not.toHaveBeenCalled();
		watch.noteUpdate(tool(status));
		vi.advanceTimersByTime(100);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 100);
		watch.dispose();
	});

	it("times out a native tool that never reports completion", () => {
		const { watch, timeout } = watchdog();
		watch.noteUpdate(tool("in_progress"));
		vi.advanceTimersByTime(1000);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(true, 1000);
		watch.dispose();
	});

	it("keeps nested holds independent and releases idempotent", () => {
		const { watch, timeout } = watchdog();
		const a = watch.hold(), b = watch.hold();
		a(); a(); vi.advanceTimersByTime(500);
		expect(timeout).not.toHaveBeenCalled();
		b(); vi.advanceTimersByTime(100);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 100);
		watch.dispose();
	});

	it("disposes all state and ignores releases or updates from an old prompt", () => {
		const { watch, timeout } = watchdog();
		const release = watch.hold(); watch.noteUpdate(tool("in_progress")); watch.dispose();
		release(); watch.noteUpdate(update); watch.arm(); vi.advanceTimersByTime(5000);
		expect(timeout).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("auto-aborts an idle prompt when silence continues past the stall abort window", () => {
		vi.useFakeTimers();
		const timeout = vi.fn();
		const watch = new PromptWatchdog(60_000, 60_000, timeout, 250);
		watch.arm();
		vi.advanceTimersByTime(249);
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 250);
		watch.dispose();
	});

	it("defers auto-abort while the upstream response is still streaming", () => {
		vi.useFakeTimers();
		const timeout = vi.fn();
		let streaming = true;
		const watch = new PromptWatchdog(60_000, 60_000, timeout, 150, () => streaming);
		watch.arm();
		vi.advanceTimersByTime(550);
		expect(timeout).not.toHaveBeenCalled();
		streaming = false;
		vi.advanceTimersByTime(50);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 600);
		watch.dispose();
	});

	it("still applies the idle timeout while the upstream response streams", () => {
		vi.useFakeTimers();
		const timeout = vi.fn();
		const watch = new PromptWatchdog(1000, 60_000, timeout, 150, () => true);
		watch.arm();
		vi.advanceTimersByTime(1000);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 1000);
		watch.dispose();
	});

	it("cancels a pending auto-abort when progress resumes, then re-arms", () => {
		vi.useFakeTimers();
		const timeout = vi.fn();
		const watch = new PromptWatchdog(60_000, 60_000, timeout, 250);
		watch.arm();
		vi.advanceTimersByTime(150);
		watch.noteUpdate(update);
		vi.advanceTimersByTime(200);
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(false, 250);
		watch.dispose();
	});

	it("does not auto-abort while work is outstanding", () => {
		vi.useFakeTimers();
		const timeout = vi.fn();
		const watch = new PromptWatchdog(60_000, 2000, timeout, 150);
		watch.arm();
		const release = watch.hold();
		vi.advanceTimersByTime(1999);
		expect(timeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(true, 2000);
		release();
		watch.dispose();
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid stall abort %s", (ms) => {
		expect(() => new PromptWatchdog(100, 1000, () => undefined, ms)).toThrow(RangeError);
	});

	it("clears a pending stall abort on dispose", () => {
		vi.useFakeTimers();
		const timeout = vi.fn();
		const watch = new PromptWatchdog(300, 1000, timeout, 100);
		watch.arm();
		vi.advanceTimersByTime(50);
		watch.dispose();
		vi.advanceTimersByTime(5000);
		expect(timeout).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid timeout %s", (ms) => {
		expect(() => new PromptWatchdog(ms, 1000, () => undefined)).toThrow(RangeError);
		expect(() => new PromptWatchdog(100, ms, () => undefined)).toThrow(RangeError);
	});
});
