import type { SessionConfigOption, SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

export type AcpToolUpdate = Extract<
	SessionNotification["update"],
	{ sessionUpdate: "tool_call" | "tool_call_update" }
>;

export interface AcpToolActivity {
	sessionId: string;
	piSessionId?: string;
	/** Original notification, including provider metadata and all content variants. */
	update: AcpToolUpdate;
	/** Current state after applying this update. An orphan update may have no title. */
	toolCall: ToolCallUpdate;
}

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "tool"; update: AcpToolUpdate }
	| { type: "plan"; text: string }
	/** Tokens in the context window after the latest model call. */
	| { type: "usage"; used: number; size: number }
	| { type: "config"; configOptions: SessionConfigOption[] }
	| { type: "unknown"; updateType: string };

export function mapSessionUpdate(notification: SessionNotification): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text"
				? [{ type: "text", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_message:${update.content.type}` }];
		case "agent_thought_chunk":
			return update.content.type === "text"
				? [{ type: "thought", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_thought:${update.content.type}` }];
		case "tool_call":
		case "tool_call_update":
			return [{ type: "tool", update }];
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		case "usage_update":
			return Number.isSafeInteger(update.used) && update.used >= 0 && Number.isSafeInteger(update.size) && update.size > 0
				? [{ type: "usage", used: update.used, size: update.size }]
				: [{ type: "unknown", updateType: "usage_update:invalid" }];
		case "config_option_update":
			return [{ type: "config", configOptions: update.configOptions }];
		default:
			return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

/** ACP updates replace supplied fields; omitted/null optional fields leave state unchanged. */
export class AcpToolTracker {
	private readonly calls = new Map<string, ToolCallUpdate>();

	apply(update: AcpToolUpdate): ToolCallUpdate {
		const { sessionUpdate, ...fields } = update;
		const previous = sessionUpdate === "tool_call" ? undefined : this.calls.get(fields.toolCallId);
		const call: ToolCallUpdate = { ...previous, toolCallId: fields.toolCallId };
		for (const key of Object.keys(fields) as Array<keyof ToolCall>) {
			const value = fields[key];
			// rawInput/rawOutput are arbitrary JSON: null is a valid explicit value.
			if (value !== undefined && (value !== null || key === "rawInput" || key === "rawOutput")) {
				Object.assign(call, { [key]: value });
			}
		}
		this.calls.set(call.toolCallId, call);
		return call;
	}

	clear(): void {
		this.calls.clear();
	}
}

export function toolActivitySummary(activity: AcpToolActivity): string {
	const call = activity.toolCall;
	return `Antigravity tool: ${clean(call.title ?? call.toolCallId)} [${call.status ?? "pending"}]${call.kind ? ` (${call.kind})` : ""}`;
}

export function toolActivityDetails(activity: AcpToolActivity): string {
	return `${toolActivitySummary(activity)}\n${JSON.stringify(activity, null, 2)}`;
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
