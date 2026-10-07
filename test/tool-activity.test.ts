import { initTheme, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerToolActivity, TOOL_ACTIVITY_ENTRY, type ToolActivityEntry } from "../extensions/tool-activity.js";
import type { AcpToolActivity } from "../src/acp/events.js";
import { decodeNativeReadResult, type NativeReadResult } from "../src/acp/native-read-results.js";
import { nativeReadStep } from "./fixtures/native-read-step.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const activity: AcpToolActivity = {
	sessionId: "acp", piSessionId: "pi",
	update: { sessionUpdate: "tool_call", toolCallId: "call", title: "ls -la", kind: "execute", status: "in_progress", rawInput: { command: "ls -la" } },
	toolCall: { toolCallId: "call", title: "ls -la", kind: "execute", status: "in_progress", rawInput: { command: "ls -la" } },
};

function harness(loadReadResults?: (sessionId: string) => Promise<NativeReadResult[]>) {
	const appendEntry = vi.fn();
	const registerEntryRenderer = vi.fn();
	const on = vi.fn();
	const sendMessage = vi.fn();
	const registerTool = vi.fn();
	const pi = { appendEntry, registerEntryRenderer, on, sendMessage, registerTool } as unknown as ExtensionAPI;
	const receive = registerToolActivity(pi, loadReadResults);
	const render = registerEntryRenderer.mock.calls[0]?.[1] as EntryRenderer<ToolActivityEntry>;
	const entry = (index: number) => ({ type: "custom" as const, id: `entry-${index}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: TOOL_ACTIVITY_ENTRY, data: appendEntry.mock.calls[index]?.[1] as ToolActivityEntry });
	return { receive, render, entry, appendEntry, registerEntryRenderer, on, sendMessage, registerTool };
}

function completed(): AcpToolActivity {
	return {
		...activity,
		update: { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", rawOutput: "first\nsecond\nthird\nfourth\nfifth\nsixth" },
		toolCall: { ...activity.toolCall, status: "completed", rawOutput: "first\nsecond\nthird\nfourth\nfifth\nsixth" },
	};
}

function nativeRead(id = "read"): AcpToolActivity {
	const toolCall: AcpToolActivity["toolCall"] = {
		toolCallId: id, kind: "read", title: "Running view_file", status: "in_progress",
		rawInput: { AbsolutePath: "/workspace/file.ts", StartLine: 1, EndLine: 10 },
	};
	return {
		...activity, toolCall,
		update: { sessionUpdate: "tool_call", toolCallId: id, title: "Running view_file", kind: "read", status: "in_progress", rawInput: toolCall.rawInput },
	};
}

function nativeFailure(): AcpToolActivity {
	const original = nativeRead();
	return {
		...original,
		toolCall: { ...original.toolCall, status: "failed", rawOutput: "Tool execution failed" },
		update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "failed", rawOutput: "Tool execution failed" },
	};
}

function evidence(options: Parameters<typeof nativeReadStep>[0] = {}): NativeReadResult {
	return decodeNativeReadResult(nativeReadStep({
		id: "read", startedAt: Date.now() - 5, completedAt: Date.now() + 100, ...options,
	}), options.id === "other" ? 454 : 453)!;
}

describe("tool activity entries", () => {
	it("persists full data without sending model messages or registering executable tools", () => {
		const h = harness();
		h.receive(activity);
		expect(h.appendEntry).toHaveBeenCalledWith(TOOL_ACTIVITY_ENTRY, expect.objectContaining(activity));
		expect(h.entry(0).data.rowId).toEqual(expect.any(String));
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.registerTool).not.toHaveBeenCalled();
	});

	it("uses Pi's native shell header, output preview, and gutters", () => {
		const h = harness();
		h.receive(completed());
		const component = h.render(h.entry(0), { expanded: false }, theme);
		const compact = stripTerminalSequences(component!.render(80).join("\n"));
		expect(compact).toMatch(/⏺ (?:\$ ls -la|Bash\(ls -la\))/u);
		expect(compact).toContain("⎿");
		expect(compact).toContain("sixth");
		expect(compact).toContain("to expand");
		expect(compact).not.toContain("Antigravity tool:");
		expect(compact).not.toContain("rawInput");
		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain("first");
		expect(expanded).toContain("rawInput");
		expect(expanded).toContain("rawOutput");
	});

	it("updates the first row in place while retaining every raw update", () => {
		const h = harness();
		h.receive(activity);
		const row = h.render(h.entry(0), { expanded: false }, theme)!;
		expect(stripTerminalSequences(row.render(80).join("\n"))).not.toContain("sixth");
		h.receive(completed());
		expect(h.entry(1).data.rowId).toBe(h.entry(0).data.rowId);
		expect(h.render(h.entry(1), { expanded: false }, theme)).toBeUndefined();
		expect(stripTerminalSequences(row.render(80).join("\n"))).toContain("sixth");
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
	});

	it("separates concurrent tools and reused ACP IDs", () => {
		const h = harness();
		h.receive(activity);
		h.receive({ ...activity, toolCall: { ...activity.toolCall, toolCallId: "other" }, update: { ...activity.update, toolCallId: "other" } });
		h.receive(completed());
		h.receive(activity);
		expect(h.entry(2).data.rowId).toBe(h.entry(0).data.rowId);
		expect(h.entry(1).data.rowId).not.toBe(h.entry(0).data.rowId);
		expect(h.entry(3).data.rowId).not.toBe(h.entry(0).data.rowId);
	});

	it("restores one row at the latest status from persisted entries", () => {
		const source = harness();
		source.receive(activity);
		source.receive(completed());
		const restored = harness();
		const restore = restored.on.mock.calls.find(([event]) => event === "session_start")?.[1];
		restore({}, { cwd: process.cwd(), sessionManager: { getBranch: () => [source.entry(0), source.entry(1)] } });
		expect(restored.render(source.entry(1), { expanded: false }, theme)).toBeUndefined();
		const row = restored.render(source.entry(0), { expanded: false }, theme)!;
		expect(stripTerminalSequences(row.render(80).join("\n"))).toContain("sixth");
	});

	it("uses the native read renderer and shows resource text", () => {
		const h = harness();
		h.receive({ ...activity, toolCall: {
			toolCallId: "read", title: "Read file", kind: "read", status: "completed",
			rawInput: { file_path: "src/file.ts", offset: 2, limit: 3 },
			content: [{ type: "content", content: { type: "resource", resource: { uri: "file:///file.ts", text: "const value = 1;" } } }],
		} });
		const text = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(text.toLowerCase()).toContain("read");
		expect(text).toContain("file.ts");
		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain("const value = 1;");
	});

	it("shows an ambiguous view_file failure as unconfirmed without changing the raw record", () => {
		const h = harness();
		const call: AcpToolActivity["toolCall"] = {
			toolCallId: "read", title: "Running view_file", kind: "read", status: "failed",
			rawInput: { AbsolutePath: "/workspace/file.ts" },
			locations: [{ path: "/workspace/file.ts" }],
			rawOutput: "Tool execution failed",
		};
		const failed: AcpToolActivity = {
			...activity,
			update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "failed", rawOutput: call.rawOutput },
			toolCall: call,
		};
		h.receive(failed);
		const colors = vi.spyOn(theme, "fg");
		const row = h.render(h.entry(0), { expanded: false }, theme)!;
		const text = stripTerminalSequences(row.render(80).join("\n"));
		expect(text).toContain("read result unconfirmed");
		expect(text).not.toContain("Tool execution failed");
		expect(colors).toHaveBeenCalledWith("warning", "⏺");
		expect(colors).not.toHaveBeenCalledWith("success", "⏺");
		expect(colors).not.toHaveBeenCalledWith("error", "⏺");
		expect(h.entry(0).data).toMatchObject(failed);
		expect(call.status).toBe("failed");
		expect(h.sendMessage).not.toHaveBeenCalled();
		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain("Tool execution failed");
		expect(expanded).toContain('"status": "failed"');
		for (const width of [24, 12, 4, 1]) {
			for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// A later authoritative completion replaces the warning on the same row.
		colors.mockClear();
		h.receive({
			...failed,
			update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed", rawOutput: "const value = 1;" },
			toolCall: { ...call, status: "completed", rawOutput: "const value = 1;" },
		});
		expect(h.entry(1).data.rowId).toBe(h.entry(0).data.rowId);
		expect(stripTerminalSequences(row.render(80).join("\n"))).not.toContain("unconfirmed");
		expect(colors).toHaveBeenCalledWith("success", "⏺");

		// Restoring an older session uses the same presentation-only treatment.
		const restored = harness();
		const restore = restored.on.mock.calls.find(([event]) => event === "session_start")?.[1];
		restore({}, { cwd: process.cwd(), sessionManager: { getBranch: () => [h.entry(0)] } });
		expect(stripTerminalSequences(restored.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"))).toContain("read result unconfirmed");
	});

	it.each([
		{ title: "Running view_file", rawOutput: "ENOENT: file not found" },
		{ title: "Read file", rawOutput: "Tool execution failed" },
		{ title: "Running view_file", rawOutput: "Tool execution failed", content: [{ type: "content" as const, content: { type: "text" as const, text: "Permission denied" } }] },
	])("keeps concrete read errors and other tools marked as failed: %s", (fields) => {
		const h = harness();
		h.receive({ ...activity, toolCall: {
			toolCallId: "read", kind: "read", status: "failed",
			locations: [{ path: "/workspace/file.ts" }], ...fields,
		} });
		const colors = vi.spyOn(theme, "fg");
		const text = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(text).not.toContain("unconfirmed");
		expect(colors).toHaveBeenCalledWith("error", "⏺");
		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain(fields.content ? "Permission denied" : fields.rawOutput);
	});

	it("recovers content on the original row and keeps later bulk failures raw", async () => {
		const result = evidence();
		const h = harness(async () => [result]);
		const original = nativeRead();
		h.receive(original);
		const row = h.render(h.entry(0), { expanded: true }, theme)!;
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledTimes(2));
		expect(h.entry(1).data).toMatchObject({ ...original, readResult: result, rowId: h.entry(0).data.rowId });
		expect(h.render(h.entry(1), { expanded: false }, theme)).toBeUndefined();
		const colors = vi.spyOn(theme, "fg");
		expect(stripTerminalSequences(row.render(100).join("\n"))).toContain("const value = 1;");
		expect(colors).toHaveBeenCalledWith("success", "⏺");
		h.receive(nativeFailure());
		colors.mockClear();
		const text = stripTerminalSequences(row.render(100).join("\n"));
		expect(text).not.toContain("unconfirmed");
		expect(colors).toHaveBeenCalledWith("success", "⏺");
		expect(colors).not.toHaveBeenCalledWith("error", "⏺");
		expect(h.entry(2).data.toolCall.status).toBe("failed");
		expect(h.entry(2).data.toolCall.rawOutput).toBe("Tool execution failed");
		expect(text).toContain("Tool execution failed"); // Expanded raw ACP details.
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.registerTool).not.toHaveBeenCalled();
		expect(original.toolCall.status).toBe("in_progress");
	});

	it.each(["[Errno 2] No such file or directory", "Tool execution failed"])("shows a recorded error as failed, even if the step was DONE: %s", async (error) => {
		const h = harness(async () => [evidence({ error })]);
		h.receive(nativeRead());
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledTimes(2));
		const colors = vi.spyOn(theme, "fg");
		const text = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(100).join("\n"));
		expect(text).toContain(error);
		expect(text).not.toContain("unconfirmed");
		expect(colors).toHaveBeenCalledWith("error", "⏺");
	});

	it("restores confirmed evidence, including after an unrelated later error", async () => {
		const source = harness(async () => [evidence()]);
		source.receive(nativeRead());
		await vi.waitFor(() => expect(source.appendEntry).toHaveBeenCalledTimes(2));
		source.receive(nativeFailure());
		const load = vi.fn(async () => []);
		const h = harness(load);
		const restore = h.on.mock.calls.find(([event]) => event === "session_start")![1];
		restore({}, { cwd: process.cwd(), sessionManager: { getBranch: () => [source.entry(0), source.entry(1), source.entry(2)] } });
		const text = stripTerminalSequences(h.render(source.entry(0), { expanded: true }, theme)!.render(100).join("\n"));
		expect(text).toContain("const value = 1;");
		expect(text).not.toContain("unconfirmed");
		expect(h.render(source.entry(2), { expanded: false }, theme)).toBeUndefined();
		expect(load).not.toHaveBeenCalled();
	});

	it("backfills an older saved row using its first timestamp, not the later error timestamp", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-01-01T00:00:00Z");
		const source = harness(async () => []);
		source.receive(nativeRead());
		source.receive(nativeFailure());
		const entries = [source.entry(0), source.entry(1)].map((entry, index) => {
			const { observedAt: _observedAt, ...data } = entry.data;
			return { ...entry, data, timestamp: index === 0 ? entry.timestamp : "2026-01-01T00:10:00Z" };
		});
		const h = harness(async () => [evidence()]);
		const restore = h.on.mock.calls.find(([event]) => event === "session_start")![1];
		restore({}, { cwd: process.cwd(), sessionManager: { getBranch: () => entries } });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.appendEntry).toHaveBeenCalledTimes(1);
		expect(h.entry(0).data.readResult?.status).toBe("completed");
		expect(h.entry(0).data.rowId).toBe(entries[0]!.data.rowId);
	});

	it("separates identical concurrent reads by ID and never consumes one result twice", async () => {
		const first = evidence();
		const second = evidence({ id: "other" });
		const h = harness(async () => [first, second]);
		h.receive(nativeRead());
		h.receive(nativeRead("other"));
		await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledTimes(4));
		expect(h.entry(2).data.readResult?.toolCallId).toBe("read");
		expect(h.entry(3).data.readResult?.toolCallId).toBe("other");
		h.receive(nativeRead()); // Reused ACP ID, but there is no new response yet.
		await Promise.resolve();
		expect(h.entry(4).data.readResult).toBeUndefined();
		expect(h.entry(4).data.rowId).not.toBe(h.entry(0).data.rowId);
		expect(h.appendEntry).toHaveBeenCalledTimes(5);
	});

	it("leaves two indistinguishable invocations unconfirmed rather than guessing", async () => {
		const h = harness(async () => [evidence()]);
		h.receive(nativeRead());
		h.receive(nativeRead());
		await Promise.resolve();
		await Promise.resolve();
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
		expect(h.entry(0).data.readResult).toBeUndefined();
		expect(h.entry(1).data.readResult).toBeUndefined();
	});

	it("retries delayed persisted responses while active, then stops after shutdown", async () => {
		vi.useFakeTimers();
		const result = evidence();
		const load = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([result]);
		const h = harness(load);
		h.on.mock.calls.find(([event]) => event === "agent_start")![1]();
		h.receive(nativeRead());
		await vi.advanceTimersByTimeAsync(300);
		expect(h.appendEntry).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(300);
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
		h.receive(nativeRead("missing"));
		await vi.advanceTimersByTimeAsync(0);
		h.on.mock.calls.find(([event]) => event === "session_shutdown")![1]();
		const calls = load.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		expect(load).toHaveBeenCalledTimes(calls);
	});

	it("stops periodic reads at agent_settled without imposing a tool timeout", async () => {
		vi.useFakeTimers();
		const load = vi.fn(async () => []);
		const h = harness(load);
		h.on.mock.calls.find(([event]) => event === "agent_start")![1]();
		h.receive(nativeRead());
		await vi.advanceTimersByTimeAsync(600);
		expect(load.mock.calls.length).toBeGreaterThan(1);
		h.on.mock.calls.find(([event]) => event === "agent_settled")![1]();
		await vi.advanceTimersByTimeAsync(0);
		const calls = load.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		expect(load).toHaveBeenCalledTimes(calls);
		expect(h.entry(0).data.toolCall.status).toBe("in_progress");
	});

	it.each(["session_tree", "session_shutdown"])("discards an in-flight lookup after %s", async (event) => {
		let resolve!: (value: NativeReadResult[]) => void;
		const h = harness(() => new Promise((done) => { resolve = done; }));
		h.receive(nativeRead());
		const handler = h.on.mock.calls.find(([name]) => name === event)![1];
		handler({}, { cwd: process.cwd(), sessionManager: { getBranch: () => [] } });
		resolve([evidence()]);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("preserves the warning and raw record when recovery is unavailable", async () => {
		const h = harness(async () => { throw new Error("Unavailable private store"); });
		h.receive(nativeFailure());
		await Promise.resolve();
		const text = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(100).join("\n"));
		expect(text).toContain("unconfirmed");
		expect(h.entry(0).data.toolCall.status).toBe("failed");
		expect(h.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("computes an actual change diff instead of marking the whole file replaced", () => {
		const h = harness();
		const before = Array.from({ length: 30 }, (_, i) => `unchanged ${i}`);
		const after = [...before];
		after[15] = "changed line";
		h.receive({ ...activity, toolCall: {
			toolCallId: "edit", kind: "edit", status: "completed",
			content: [{ type: "diff", path: "file.txt", oldText: before.join("\n"), newText: after.join("\n") }],
		} });
		const text = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(text).toContain("file.txt");
		expect(text).toContain("-16 unchanged 15");
		expect(text).toContain("+16 changed line");
		expect(text).not.toContain("-1 unchanged 0");
	});

	it("renders file paths, diffs and errors without overflowing narrow widths", () => {
		const h = harness();
		h.receive({
			...activity,
			toolCall: { toolCallId: "call", title: "Edit 文件", kind: "edit", status: "failed", locations: [{ path: "src/文件.ts" }], rawOutput: "could not edit", content: [{ type: "diff", path: "src/文件.ts", oldText: "const old = 1;", newText: "const next = 2;" }] },
		});
		const row = h.render(h.entry(0), { expanded: false }, theme)!;
		const lines = row.render(24);
		const text = stripTerminalSequences(lines.join("\n"));
		expect(text).toMatch(/(?:edit |Edit\()/u);
		expect(text).toContain("文件.ts");
		expect(text).toContain("could not edit");
		expect(text).toContain("const next");
		for (const width of [24, 12, 4, 1]) {
			for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
