import { initTheme, type CustomEntry, type EntryRenderOptions, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerToolActivity, TOOL_ACTIVITY_ENTRY, type RegisterToolActivityOptions, type ToolActivityEntry } from "../extensions/tool-activity.js";
import type { AcpToolActivity } from "../src/acp/events.js";

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

function harness(options?: RegisterToolActivityOptions) {
	const appendEntry = vi.fn();
	const registerEntryRenderer = vi.fn();
	const on = vi.fn();
	const sendMessage = vi.fn();
	const registerTool = vi.fn();
	const pi = { appendEntry, registerEntryRenderer, on, sendMessage, registerTool } as unknown as ExtensionAPI;
	const receive = registerToolActivity(pi, { collapseToolOutput: () => true, ...options });
	const rawRender = registerEntryRenderer.mock.calls.find(([type]) => type === TOOL_ACTIVITY_ENTRY)?.[1] as EntryRenderer<ToolActivityEntry>;
	const withKeyHints = (opts: { expanded: boolean } & Partial<EntryRenderOptions>): EntryRenderOptions => ({
		keyText: () => "",
		keyHint: (_key, description) => description,
		...opts,
	});
	const render = (entry: CustomEntry<ToolActivityEntry>, opts: { expanded: boolean } & Partial<EntryRenderOptions>, t: Theme) =>
		rawRender(entry, withKeyHints(opts), t);
	const emit = (eventName: string, event: unknown, ctx?: unknown) => {
		for (const [name, handler] of on.mock.calls) {
			if (name === eventName) handler(event, ctx);
		}
	};
	const entry = (index: number) => ({
		type: "custom" as const,
		id: `entry-${index}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: appendEntry.mock.calls[index]?.[0] as string,
		data: appendEntry.mock.calls[index]?.[1] as ToolActivityEntry,
	});
	return { receive, render, emit, entry, appendEntry, registerEntryRenderer, on, sendMessage, registerTool };
}

function completed(): AcpToolActivity {
	return {
		...activity,
		update: { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", rawOutput: "first\nsecond\nthird\nfourth\nfifth\nsixth" },
		toolCall: { ...activity.toolCall, status: "completed", rawOutput: "first\nsecond\nthird\nfourth\nfifth\nsixth" },
	};
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
		expect(expanded).toContain("sixth");
		expect(expanded).not.toContain("ACP details");
		expect(expanded).not.toContain("rawInput");
		expect(expanded).not.toContain("rawOutput");
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

	it("restores one row at the latest status from persisted entries and collapses finished execute previews", () => {
		const source = harness();
		source.receive(activity);
		source.receive(completed());
		const restored = harness();
		restored.emit("session_start", {}, { cwd: process.cwd(), sessionManager: { getBranch: () => [source.entry(0), source.entry(1)] } });
		expect(restored.render(source.entry(1), { expanded: false }, theme)).toBeUndefined();
		const collapsed = stripTerminalSequences(restored.render(source.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(collapsed).toContain("ls -la");
		expect(collapsed).not.toContain("sixth");
		const expanded = stripTerminalSequences(restored.render(source.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain("sixth");
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

	it("renders agy CLI native Path and CommandLine rawInput fields", () => {
		const h = harness();
		h.receive({
			...activity,
			toolCall: {
				toolCallId: "read-1",
				title: "Read file",
				kind: "read",
				status: "completed",
				rawInput: { Path: "src/index.ts", StartLine: 10, EndLine: 25 },
				rawOutput: "line 10",
			},
		});
		h.receive({
			...activity,
			toolCall: {
				toolCallId: "bash-1",
				title: "Run command",
				kind: "execute",
				status: "completed",
				rawInput: { CommandLine: "echo native-ok" },
				rawOutput: "native-ok",
			},
		});
		const readText = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(readText).toContain("src/index.ts");
		expect(readText).toContain("10");
		const bashText = stripTerminalSequences(h.render(h.entry(1), { expanded: false }, theme)!.render(80).join("\n"));
		expect(bashText).toContain("echo native-ok");
		expect(bashText).toContain("native-ok");
	});

	it("compacts full-file diffs before persisting, strips empty {} edit rawOutput, and cleans agy command timestamps", () => {
		const h = harness();
		const bigBefore = Array.from({ length: 400 }, (_, i) => `const line_${i} = ${i};`).join("\n");
		const bigAfter = bigBefore.replace("const line_200 = 200;", "const line_200 = 999;");
		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "edit-big",
				kind: "edit",
				status: "completed",
				rawOutput: {},
				content: [{ type: "diff", path: "src/big.ts", oldText: bigBefore, newText: bigAfter }],
			},
			toolCall: {
				toolCallId: "edit-big",
				kind: "edit",
				status: "completed",
				rawOutput: {},
				content: [{ type: "diff", path: "src/big.ts", oldText: bigBefore, newText: bigAfter }],
			},
		});
		const persisted = h.entry(0).data;
		const serialized = JSON.stringify(persisted);
		expect(serialized.length).toBeLessThan(2_000);
		expect(serialized).not.toContain("const line_10 = 10;");
		expect(persisted.diffs?.[0]?.path).toBe("src/big.ts");
		const editText = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(100).join("\n"));
		expect(editText).toContain("-201 const line_200 = 200;");
		expect(editText).toContain("+201 const line_200 = 999;");
		expect(editText).not.toContain("expand to view");
		expect(editText).not.toContain("{}");
		expect(editText).not.toContain("ACP details");

		// Even multi-hunk / >6-line diffs stay fully visible when collapsed (matching Pi's native edit UX).
		const multiAfter = bigBefore
			.replace("const line_10 = 10;", "const line_10 = 1001;")
			.replace("const line_200 = 200;", "const line_200 = 2002;");
		h.receive({
			...activity,
			toolCall: {
				toolCallId: "edit-multi",
				kind: "edit",
				status: "completed",
				rawOutput: {},
				content: [{ type: "diff", path: "src/big.ts", oldText: bigBefore, newText: multiAfter }],
			},
		});
		const multiText = stripTerminalSequences(h.render(h.entry(1), { expanded: false }, theme)!.render(100).join("\n"));
		expect(multiText).toContain("+11 const line_10 = 1001;");
		expect(multiText).toContain("+201 const line_200 = 2002;");
		expect(multiText).not.toContain("expand to view");

		h.receive({
			...activity,
			toolCall: {
				toolCallId: "bash-meta",
				kind: "execute",
				status: "completed",
				rawInput: { CommandLine: "rm foo.ts" },
				content: [{
					type: "content",
					content: {
						type: "text",
						text: "Created At: 2026-11-23T13:18:14+08:00\nCompleted At: 2026-11-23T13:18:18+08:00\nCommand exited with code 0.\n\nNo output from the command.",
					},
				}],
			},
		});
		const bashText = stripTerminalSequences(h.render(h.entry(2), { expanded: true }, theme)!.render(100).join("\n"));
		expect(bashText).toContain("rm foo.ts");
		expect(bashText).toContain("(no output)");
		expect(bashText).toContain("Took 4.0s");
		expect(bashText).not.toContain("Created At:");
		expect(bashText).not.toContain("ACP details");

		h.receive({
			...activity,
			toolCall: {
				toolCallId: "read-empty",
				kind: "read",
				status: "completed",
				rawInput: { Path: "src/missing.ts", StartLine: 10, EndLine: 29 },
			},
		});
		const readText = stripTerminalSequences(h.render(h.entry(3), { expanded: false }, theme)!.render(100).join("\n"));
		expect(readText).toContain("Read 1 file");
		expect(readText).toContain("└─ src/missing.ts:10-29");
		const readExpanded = stripTerminalSequences(h.render(h.entry(3), { expanded: true }, theme)!.render(100).join("\n"));
		expect(readExpanded).toContain("Read 20 lines");
	});

	it("auto-collapses execute output on agent_end while keeping read and edit previews visible", () => {
		const h = harness();
		h.receive(completed());
		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read file", kind: "read", status: "completed" },
			toolCall: { toolCallId: "read-1", title: "Read file", kind: "read", status: "completed", rawInput: { Path: "src/a.ts", StartLine: 1, EndLine: 5 } },
		});
		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit file", kind: "edit", status: "completed" },
			toolCall: {
				toolCallId: "edit-1",
				title: "Edit file",
				kind: "edit",
				status: "completed",
				content: [{ type: "diff", path: "src/a.ts", oldText: "old", newText: "new" }],
			},
		});

		const execRow = h.render(h.entry(0), { expanded: false }, theme)!;
		const readRow = h.render(h.entry(1), { expanded: false }, theme)!;
		const editRow = h.render(h.entry(2), { expanded: false }, theme)!;

		// Before agent_end, execute preview is visible.
		expect(stripTerminalSequences(execRow.render(80).join("\n"))).toContain("sixth");

		// After agent_end, execute collapses to header only; read and edit stay visible.
		h.emit("agent_end", { type: "agent_end", messages: [] });
		const collapsedExec = stripTerminalSequences(execRow.render(80).join("\n"));
		expect(collapsedExec).toContain("ls -la");
		expect(collapsedExec).not.toContain("sixth");
		expect(collapsedExec).not.toContain("⎿");
		expect(stripTerminalSequences(readRow.render(80).join("\n"))).toContain("Read 1 file");
		expect(stripTerminalSequences(readRow.render(80).join("\n"))).toContain("└─ src/a.ts:1-5");
		expect(stripTerminalSequences(editRow.render(80).join("\n"))).toContain("+1 new");

		// Expanding (Ctrl+O) still reveals the collapsed execute output.
		const expandedExec = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expandedExec).toContain("sixth");
	});

	it("respects collapseToolOutput=false setting on agent_end", () => {
		const h = harness({ collapseToolOutput: () => false });
		h.receive(completed());
		const execRow = h.render(h.entry(0), { expanded: false }, theme)!;
		h.emit("agent_end", { type: "agent_end", messages: [] });
		expect(stripTerminalSequences(execRow.render(80).join("\n"))).toContain("sixth");
	});

	it("shows live elapsed time while execute runs and persists Took/collapsed duration after completion", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T10:00:00.000Z"));
		const h = harness();
		h.receive(activity);
		const row = h.render(h.entry(0), { expanded: false }, theme)!;

		vi.advanceTimersByTime(2_300);
		const running = stripTerminalSequences(row.render(80).join("\n"));
		expect(running).toContain("Elapsed 2.3s");

		vi.advanceTimersByTime(1_100);
		h.receive(completed());
		expect(h.entry(1).data.durationMs).toBe(3_400);

		const finished = stripTerminalSequences(row.render(80).join("\n"));
		expect(finished).toContain("Took 3.4s");

		h.emit("agent_end", { type: "agent_end", messages: [] });
		const collapsed = stripTerminalSequences(row.render(80).join("\n"));
		expect(collapsed).toContain("ls -la");
		expect(collapsed).toContain("(3.4s)");
		expect(collapsed).not.toContain("⎿");
		for (const width of [80, 20, 10, 4]) {
			for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain("Took 3.4s");

		// Restored session preserves duration on collapsed header and expanded output.
		const restored = harness();
		restored.emit("session_start", {}, { cwd: process.cwd(), sessionManager: { getBranch: () => [h.entry(0), h.entry(1)] } });
		const restoredCollapsed = stripTerminalSequences(restored.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(restoredCollapsed).toContain("(3.4s)");
		const restoredExpanded = stripTerminalSequences(restored.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(restoredExpanded).toContain("Took 3.4s");
	});

	it("groups consecutive read activities into Reading/Read N files with branch paths and seals across non-read boundaries", () => {
		const h = harness();
		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read file", kind: "read", status: "in_progress" },
			toolCall: { toolCallId: "r1", title: "Read file", kind: "read", status: "in_progress", rawInput: { Path: "src/a.ts", StartLine: 1, EndLine: 20 } },
		});
		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call", toolCallId: "r2", title: "Read file", kind: "read", status: "in_progress" },
			toolCall: { toolCallId: "r2", title: "Read file", kind: "read", status: "in_progress", rawInput: { Path: "src/b.ts" } },
		});

		const groupComp = h.render(h.entry(0), { expanded: false }, theme)!;
		expect(h.render(h.entry(1), { expanded: false }, theme)).toBeUndefined();
		const running = stripTerminalSequences(groupComp.render(80).join("\n"));
		expect(running).toContain("⏺ Reading 2 files...");
		expect(running).toContain("└─ src/a.ts:1-20");
		expect(running).toContain("└─ src/b.ts");

		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed", rawOutput: "const a = 1;" },
			toolCall: { toolCallId: "r1", title: "Read file", kind: "read", status: "completed", rawInput: { Path: "src/a.ts", StartLine: 1, EndLine: 20 }, rawOutput: "const a = 1;" },
		});
		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call_update", toolCallId: "r2", status: "failed", rawOutput: "ENOENT: no such file" },
			toolCall: { toolCallId: "r2", title: "Read file", kind: "read", status: "failed", rawInput: { Path: "src/b.ts" }, rawOutput: "ENOENT: no such file" },
		});
		expect(h.render(h.entry(2), { expanded: false }, theme)).toBeUndefined();
		expect(h.render(h.entry(3), { expanded: false }, theme)).toBeUndefined();

		const finished = stripTerminalSequences(groupComp.render(80).join("\n"));
		expect(finished).toContain("⏺ Read 2 files");
		expect(finished).toContain("└─ src/a.ts:1-20");
		expect(finished).toContain("└─ src/b.ts ENOENT: no such file");
		expect(finished).not.toContain("const a = 1;");

		const taggedTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as Theme;
		const taggedFinished = h.render(h.entry(0), { expanded: false }, taggedTheme)!.render(80).join("\n");
		expect(taggedFinished).toContain("<muted>src/a.ts:1-20</muted>");
		expect(taggedFinished).not.toContain("<accent>src/a.ts</accent>");
		expect(taggedFinished).not.toContain("<warning>:1-20</warning>");

		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(80).join("\n"));
		expect(expanded).toContain("const a = 1;");
		expect(expanded).toContain("ENOENT: no such file");

		for (const width of [80, 24, 10, 4]) {
			for (const line of groupComp.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Non-read tool seals the previous read group; a later read starts a new group.
		h.receive(completed());
		h.receive({
			...activity,
			update: { sessionUpdate: "tool_call", toolCallId: "r3", title: "Read file", kind: "read", status: "completed" },
			toolCall: { toolCallId: "r3", title: "Read file", kind: "read", status: "completed", rawInput: { Path: "src/c.ts" } },
		});
		const secondGroup = h.render(h.entry(5), { expanded: false }, theme)!;
		expect(secondGroup).toBeDefined();
		const secondText = stripTerminalSequences(secondGroup.render(80).join("\n"));
		expect(secondText).toContain("⏺ Read 1 file");
		expect(secondText).toContain("└─ src/c.ts");

		// Session restore reproduces the same two separate read groups.
		const restored = harness();
		restored.emit("session_start", {}, {
			cwd: process.cwd(),
			sessionManager: {
				getBranch: () => [h.entry(0), h.entry(1), h.entry(2), h.entry(3), h.entry(4), h.entry(5)],
			},
		});
		expect(restored.render(h.entry(1), { expanded: false }, theme)).toBeUndefined();
		const restoredFirst = stripTerminalSequences(restored.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(restoredFirst).toContain("⏺ Read 2 files");
		expect(restoredFirst).toContain("└─ src/a.ts:1-20");
		expect(restoredFirst).toContain("└─ src/b.ts ENOENT: no such file");
		const restoredSecond = stripTerminalSequences(restored.render(h.entry(5), { expanded: false }, theme)!.render(80).join("\n"));
		expect(restoredSecond).toContain("⏺ Read 1 file");
		expect(restoredSecond).toContain("└─ src/c.ts");
	});

	it("renders generic ACP tools (like manage_task) with rawInput args, head-first output preview, timing, and expanded details", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T10:34:39.000Z"));
		const h = harness();
		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "mt-1",
				title: "Run manage_task",
				kind: "other",
				status: "in_progress",
				rawInput: { Action: "kill", TaskId: "1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2" },
			},
			toolCall: {
				toolCallId: "mt-1",
				title: "Run manage_task",
				kind: "other",
				status: "in_progress",
				rawInput: { Action: "kill", TaskId: "1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2" },
			},
		});
		const row = h.render(h.entry(0), { expanded: false }, theme)!;
		vi.advanceTimersByTime(1_500);
		const running = stripTerminalSequences(row.render(100).join("\n"));
		expect(running).toContain('⏺ Run manage_task Action="kill" TaskId="1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2"');
		expect(running).toContain("Elapsed 1.5s");

		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "mt-1",
				title: "Run manage_task",
				kind: "other",
				status: "completed",
				rawInput: { Action: "kill", TaskId: "1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2" },
			},
			toolCall: {
				toolCallId: "mt-1",
				title: "Run manage_task",
				kind: "other",
				status: "completed",
				rawInput: { Action: "kill", TaskId: "1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2" },
			},
		});
		const finished = stripTerminalSequences(row.render(100).join("\n"));
		expect(finished).toContain('Action="kill"');
		expect(finished).toContain("Took 1.5s");

		h.emit("agent_end", { type: "agent_end", messages: [] });
		const collapsed = stripTerminalSequences(row.render(100).join("\n"));
		expect(collapsed).toContain('Run manage_task Action="kill" TaskId="1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2" (1.5s)');
		expect(collapsed).not.toContain("⎿");

		const expanded = stripTerminalSequences(h.render(h.entry(0), { expanded: true }, theme)!.render(100).join("\n"));
		expect(expanded).toContain("Action: kill");
		expect(expanded).toContain("TaskId: 1e5ca6bc-9a5a-4b3b-aeb2-3ddc374bbec2/task-2");
		expect(expanded).toContain("Took 1.5s");

		// Multi-line generic tool output previews from the first line (not bash tail) and omits empty string args when collapsed.
		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "generic-1",
				title: "Run list_resources",
				kind: "other",
				status: "completed",
				rawInput: { server: "pi-bridge", cursor: "", filter: "" },
				rawOutput: "line1\nline2\nline3\nline4\nline5\nline6\nline7",
			},
			toolCall: {
				toolCallId: "generic-1",
				title: "Run list_resources",
				kind: "other",
				status: "completed",
				rawInput: { server: "pi-bridge", cursor: "", filter: "" },
				rawOutput: "line1\nline2\nline3\nline4\nline5\nline6\nline7",
			},
		});
		const genericRow = h.render(h.entry(2), { expanded: false }, theme)!;
		const preview = stripTerminalSequences(genericRow.render(100).join("\n"));
		expect(preview).toContain('Run list_resources server="pi-bridge"');
		expect(preview).not.toContain('cursor=""');
		expect(preview).toContain("line1");
		expect(preview).toContain("line5");
		expect(preview).not.toContain("line6");
		expect(preview).toContain("... (2 more lines, to expand)");

		const genericExpanded = stripTerminalSequences(h.render(h.entry(2), { expanded: true }, theme)!.render(100).join("\n"));
		expect(genericExpanded).toContain("server: pi-bridge");
		expect(genericExpanded).toContain("line1");
		expect(genericExpanded).toContain("line7");

		for (const width of [100, 24, 10, 4, 1]) {
			for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			for (const line of genericRow.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders search_web as clean WebSearch(...) without duplicated query, escaped quotes, or 'on Web'", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-26T14:32:22.000Z"));
		const h = harness();
		const quotedQuery = '"Rex" "Superlogical" iOS OR TestFlight OR mobile connect server ssh http tailscale';
		const agyTitle = `${JSON.stringify(quotedQuery)} on Web`;

		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "search-1",
				title: agyTitle,
				kind: "search",
				status: "in_progress",
				rawInput: { query: quotedQuery },
			},
			toolCall: {
				toolCallId: "search-1",
				title: agyTitle,
				kind: "search",
				status: "in_progress",
				rawInput: { query: quotedQuery },
			},
		});
		const row = h.render(h.entry(0), { expanded: false }, theme)!;
		vi.advanceTimersByTime(3_500);
		const running = stripTerminalSequences(row.render(120).join("\n"));
		expect(running).toContain(`⏺ WebSearch(${quotedQuery})`);
		expect(running).toContain("Elapsed 3.5s");
		expect(running).not.toContain("on Web");
		expect(running).not.toContain("query=");
		expect(running).not.toContain('\\"');
		expect(running.split("Superlogical").length - 1).toBe(1);

		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "search-1",
				title: agyTitle,
				kind: "search",
				status: "completed",
				rawInput: { query: quotedQuery },
			},
			toolCall: {
				toolCallId: "search-1",
				title: agyTitle,
				kind: "search",
				status: "completed",
				rawInput: { query: quotedQuery },
			},
		});
		const finished = stripTerminalSequences(row.render(120).join("\n"));
		expect(finished).toContain(`⏺ WebSearch(${quotedQuery})`);
		expect(finished).toContain("Took 3.5s");

		h.emit("agent_end", { type: "agent_end", messages: [] });
		const collapsed = stripTerminalSequences(row.render(120).join("\n"));
		expect(collapsed).toContain(`⏺ WebSearch(${quotedQuery}) (3.5s)`);
		expect(collapsed).not.toContain("⎿");

		// Domain suffix is shown cleanly and empty domain is omitted.
		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "search-domain",
				title: '"rex mobile" on Web',
				kind: "search",
				status: "completed",
				rawInput: { query: "rex mobile", domain: "superlogical.com" },
			},
			toolCall: {
				toolCallId: "search-domain",
				title: '"rex mobile" on Web',
				kind: "search",
				status: "completed",
				rawInput: { query: "rex mobile", domain: "superlogical.com" },
			},
		});
		const domainText = stripTerminalSequences(h.render(h.entry(2), { expanded: false }, theme)!.render(100).join("\n"));
		expect(domainText).toContain("⏺ WebSearch(rex mobile) in superlogical.com");
		expect(domainText).not.toContain("on Web");
		expect(domainText).not.toContain("domain=");

		// Title-only '"..." on Web' without rawInput unescapes and extracts the query.
		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "search-title-only",
				title: '"\\"Rex\\" terminal" on Web',
				kind: "search",
				status: "completed",
			},
			toolCall: {
				toolCallId: "search-title-only",
				title: '"\\"Rex\\" terminal" on Web',
				kind: "search",
				status: "completed",
			},
		});
		const titleOnlyText = stripTerminalSequences(h.render(h.entry(3), { expanded: false }, theme)!.render(100).join("\n"));
		expect(titleOnlyText).toContain('⏺ WebSearch("Rex" terminal)');
		expect(titleOnlyText).not.toContain("on Web");

		// Long query truncates to 2 visual lines with …) when collapsed and expands fully when expanded.
		const longQuery = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
		h.receive({
			...activity,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "search-long",
				title: `${JSON.stringify(longQuery)} on Web`,
				kind: "search",
				status: "completed",
				rawInput: { query: longQuery, domain: "docs.example.com" },
				rawOutput: "result-1\nresult-2\nresult-3\nresult-4\nresult-5\nresult-6",
			},
			toolCall: {
				toolCallId: "search-long",
				title: `${JSON.stringify(longQuery)} on Web`,
				kind: "search",
				status: "completed",
				rawInput: { query: longQuery, domain: "docs.example.com" },
				rawOutput: "result-1\nresult-2\nresult-3\nresult-4\nresult-5\nresult-6",
			},
		});
		const longRow = h.render(h.entry(4), { expanded: false }, theme)!;
		const longCollapsedLines = longRow.render(60);
		const longCollapsed = stripTerminalSequences(longCollapsedLines.join("\n"));
		const headerLines = longCollapsed.split("\n").filter((line) => !line.includes("result-") && !line.includes("more line"));
		expect(headerLines.length).toBeLessThanOrEqual(2);
		expect(headerLines.join(" ")).toContain("…) in docs.example.com");
		expect(longCollapsed).toContain("result-1");
		expect(longCollapsed).toContain("result-5");
		expect(longCollapsed).not.toContain("result-6");

		const longExpanded = stripTerminalSequences(h.render(h.entry(4), { expanded: true }, theme)!.render(60).join("\n"));
		expect(longExpanded).toContain("omega)");
		expect(longExpanded).toContain("in docs.example.com");
		expect(longExpanded).toContain("result-6");

		for (const width of [100, 40, 24, 10, 4, 1]) {
			for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			for (const line of longRow.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("ignores tool activities from other sessions (such as swarm workers) and unattributed side streams", () => {
		const h = harness();
		h.emit("session_start", {}, {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "main-session", getBranch: () => [] },
		});

		// Main session read starts a read group.
		h.receive({
			...activity,
			sessionId: "acp-main",
			piSessionId: "main-session",
			update: { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read file", kind: "read", status: "completed" },
			toolCall: { toolCallId: "r1", title: "Read file", kind: "read", status: "completed", rawInput: { Path: "src/a.ts" } },
		});

		// Swarm worker edit and unattributed side-thread read must be ignored and must not seal the main read group.
		h.receive({
			...activity,
			sessionId: "acp-worker",
			piSessionId: "swarm-worker-1",
			update: { sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit file", kind: "edit", status: "completed" },
			toolCall: {
				toolCallId: "e1",
				title: "Edit file",
				kind: "edit",
				status: "completed",
				content: [{ type: "diff", path: "src/worker.ts", oldText: "a", newText: "b" }],
			},
		});
		h.receive({
			sessionId: "acp-side",
			update: { sessionUpdate: "tool_call", toolCallId: "s1", title: "Read file", kind: "read", status: "completed" },
			toolCall: { toolCallId: "s1", title: "Read file", kind: "read", status: "completed", rawInput: { Path: "src/side.ts" } },
		});
		expect(h.appendEntry).toHaveBeenCalledTimes(1);

		// A subsequent main session read stays in the same read group.
		h.receive({
			...activity,
			sessionId: "acp-main",
			piSessionId: "main-session",
			update: { sessionUpdate: "tool_call", toolCallId: "r2", title: "Read file", kind: "read", status: "completed" },
			toolCall: { toolCallId: "r2", title: "Read file", kind: "read", status: "completed", rawInput: { Path: "src/b.ts" } },
		});
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
		const grouped = stripTerminalSequences(h.render(h.entry(0), { expanded: false }, theme)!.render(80).join("\n"));
		expect(grouped).toContain("⏺ Read 2 files");
		expect(grouped).toContain("└─ src/a.ts");
		expect(grouped).toContain("└─ src/b.ts");
		expect(h.render(h.entry(1), { expanded: false }, theme)).toBeUndefined();

		// Switching sessions updates the filter so old-session activities are dropped and new-session ones pass.
		h.emit("session_start", {}, {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "next-session", getBranch: () => [] },
		});
		h.receive({ ...activity, piSessionId: "main-session" });
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
		h.receive({ ...activity, piSessionId: "next-session" });
		expect(h.appendEntry).toHaveBeenCalledTimes(3);
	});
});
