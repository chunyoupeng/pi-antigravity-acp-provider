import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpToolTracker, type AcpToolUpdate, mapSessionUpdate, toolActivityDetails } from "../src/acp/events.js";

const initial: AcpToolUpdate = {
	sessionUpdate: "tool_call",
	toolCallId: "native-1",
	title: "Edit source",
	kind: "edit",
	status: "in_progress",
	rawInput: { path: "src/a.ts", changes: [{ old: "old", new: "new" }] },
	locations: [{ path: "src/a.ts", line: 42 }],
	content: [
		{ type: "diff", path: "src/a.ts", oldText: "old", newText: "new" },
		{ type: "content", content: { type: "text", text: "x".repeat(12_000) } },
		{ type: "content", content: { type: "image", data: "AQ==", mimeType: "image/png" } },
		{ type: "content", content: { type: "resource", resource: { uri: "file:///a", text: "resource body", mimeType: "text/plain" } } },
		{ type: "terminal", terminalId: "terminal-1" },
	],
	_meta: { provider: { extra: "preserved" } },
};

describe("ACP tool activities", () => {
	it("passes the complete structured notification through without truncation", () => {
		const notification: SessionNotification = { sessionId: "s", update: initial };
		const activities = mapSessionUpdate(notification);
		expect(activities).toEqual([{ type: "tool", update: initial }]);
		expect(activities[0]?.type === "tool" && activities[0].update).toBe(initial);
		const tracker = new AcpToolTracker();
		const details = toolActivityDetails({ sessionId: "s", update: initial, toolCall: tracker.apply(initial) });
		expect(details).toContain("x".repeat(12_000));
		expect(details).toContain('"oldText": "old"');
		expect(details).toContain('"data": "AQ=="');
		expect(details).toContain("resource body");
		expect(details).toContain("terminal-1");
		expect(details).toContain("preserved");
	});

	it("merges partial updates, preserving snapshots and replacing provided arrays", () => {
		const tracker = new AcpToolTracker();
		const first = tracker.apply(initial);
		const completed = tracker.apply({
			sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "completed",
			title: null, kind: null, locations: null, content: null,
			rawOutput: { bytes: 123, exitCode: 0 },
		});
		expect(completed).toMatchObject({ title: "Edit source", kind: "edit", status: "completed", rawInput: initial.rawInput, content: initial.content, locations: initial.locations, rawOutput: { bytes: 123, exitCode: 0 } });
		expect(first.status).toBe("in_progress");
		const empty = tracker.apply({ sessionUpdate: "tool_call_update", toolCallId: "native-1", content: [], locations: [], rawOutput: null });
		expect(empty.content).toEqual([]);
		expect(empty.locations).toEqual([]);
		expect(empty.rawOutput).toBeNull();
	});

	it("isolates concurrent IDs and tolerates an orphan update", () => {
		const tracker = new AcpToolTracker();
		tracker.apply(initial);
		const orphan = tracker.apply({ sessionUpdate: "tool_call_update", toolCallId: "other", status: "failed", rawOutput: "error" });
		expect(orphan).toEqual({ toolCallId: "other", status: "failed", rawOutput: "error" });
		expect(tracker.apply({ sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "completed" }).title).toBe("Edit source");
		tracker.clear();
		expect(tracker.apply({ sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "pending" }).title).toBeUndefined();
	});
});
