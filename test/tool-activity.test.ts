import { initTheme, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerToolActivity, TOOL_ACTIVITY_ENTRY, type ToolActivityEntry } from "../extensions/tool-activity.js";
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

function harness() {
	const appendEntry = vi.fn();
	const registerEntryRenderer = vi.fn();
	const on = vi.fn();
	const sendMessage = vi.fn();
	const registerTool = vi.fn();
	const pi = { appendEntry, registerEntryRenderer, on, sendMessage, registerTool } as unknown as ExtensionAPI;
	const receive = registerToolActivity(pi);
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
		expect(readText).toContain("src/missing.ts");
		expect(readText).toContain("Read 20 lines");
	});
});
