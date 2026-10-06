import { initTheme, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { registerToolActivity, TOOL_ACTIVITY_ENTRY, type ToolActivityEntry } from "../extensions/tool-activity.js";
import type { AcpToolActivity } from "../src/acp/events.js";

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
