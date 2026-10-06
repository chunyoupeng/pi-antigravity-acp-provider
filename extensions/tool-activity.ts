import {
	createBashToolDefinition,
	createReadToolDefinition,
	createEditToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolRenderers,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import { type Component, Image, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { structuredPatch } from "diff";

import type { AcpToolActivity } from "../src/acp/events.js";

export const TOOL_ACTIVITY_ENTRY = "antigravity-acp-tool-activity";
export interface ToolActivityEntry extends AcpToolActivity {
	/** One display row per invocation; ACP IDs can be reused in later turns. */
	rowId: string;
}

interface ToolRow {
	latest: ToolActivityEntry;
	owner?: string;
}

/** Display-only session entries: never queued as model input or executable Pi calls. */
export function registerToolActivity(pi: ExtensionAPI): (activity: AcpToolActivity) => void {
	const rows = new Map<string, ToolRow>();
	const activeCalls = new Map<string, string>();
	let cwd = process.cwd();
	// Only the presentation functions are used; execute() is never called.
	const bashDefinition = createBashToolDefinition(cwd);
	const readDefinition = createReadToolDefinition(cwd);
	const editDefinition = createEditToolDefinition(cwd);
	const bash: ToolRenderers = {
		renderCall(args, theme, context) {
			const params = { command: String(record(args).command ?? "") };
			return bashDefinition.renderCall!(params, theme, { ...context, args: params, state: { startedAt: undefined, endedAt: undefined, interval: undefined } });
		},
		renderResult(result, options, theme, context) {
			return bashDefinition.renderResult!(result, options, theme, { ...context, args: { command: "" }, state: { startedAt: undefined, endedAt: undefined, interval: undefined } });
		},
	};
	const read: ToolRenderers = {
		renderCall(args, theme, context) {
			const input = record(args);
			const params = {
				path: String(input.path ?? ""),
				...(typeof input.offset === "number" ? { offset: input.offset } : {}),
				...(typeof input.limit === "number" ? { limit: input.limit } : {}),
			};
			return readDefinition.renderCall!(params, theme, { ...context, args: params });
		},
		renderResult(result, options, theme, context) {
			const params = { path: String(record(context.args).path ?? "") };
			return readDefinition.renderResult!(result, options, theme, { ...context, args: params });
		},
	};
	const edit: ToolRenderers = {
		renderCall(args, theme, context) {
			const params = { path: String(record(args).path ?? ""), edits: [] };
			return editDefinition.renderCall!(params, theme, { ...context, args: params, state: {} });
		},
	};

	const restore = (_event: unknown, ctx: ExtensionContext) => {
		rows.clear();
		activeCalls.clear();
		cwd = ctx.cwd;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== TOOL_ACTIVITY_ENTRY) continue;
			const data = entry.data as ToolActivityEntry | undefined;
			if (!data?.rowId) continue;
			const row = rows.get(data.rowId);
			if (row) row.latest = data;
			else rows.set(data.rowId, { latest: data, owner: entry.id });
			activeCalls.set(callKey(data), data.rowId);
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerEntryRenderer<ToolActivityEntry>(TOOL_ACTIVITY_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		// An ungrouped entry still displays, but new entries always carry rowId.
		const rowId = data.rowId ?? entry.id;
		let row = rows.get(rowId);
		if (!row) {
			row = { latest: data, owner: entry.id };
			rows.set(rowId, row);
		}
		row.owner ??= entry.id;
		if (row.owner !== entry.id) return undefined;
		const currentRow = row;
		return {
			invalidate() {},
			render(width) {
				return renderToolRow(currentRow.latest, { bash, read, edit }, cwd, expanded, theme, width);
			},
		} satisfies Component;
	});

	return (activity) => {
		const key = callKey(activity);
		let rowId = activeCalls.get(key);
		if (!rowId || activity.update.sessionUpdate === "tool_call") {
			rowId = crypto.randomUUID();
			activeCalls.set(key, rowId);
		}
		const data: ToolActivityEntry = { ...activity, rowId };
		const row = rows.get(rowId);
		if (row) row.latest = data;
		else rows.set(rowId, { latest: data });
		// Every update remains in the session and JSON/RPC stream. The TUI updates
		// the first row in place and hides the later records for this invocation.
		pi.appendEntry(TOOL_ACTIVITY_ENTRY, data);
	};
}

/** One component per image block, so re-renders reuse the terminal image. */
const images = new WeakMap<object, Image>();

function callKey(activity: AcpToolActivity): string {
	return JSON.stringify([activity.sessionId, activity.toolCall.toolCallId]);
}

function renderToolRow(
	activity: AcpToolActivity,
	renderers: { bash: ToolRenderers; read: ToolRenderers; edit: ToolRenderers },
	cwd: string,
	expanded: boolean,
	theme: Theme,
	width: number,
): string[] {
	const call = activity.toolCall;
	const input = record(call.rawInput);
	const path = input.path ?? input.file_path ?? input.filePath ?? call.locations?.[0]?.path ??
		call.content?.find((item) => item.type === "diff")?.path;
	const isPartial = call.status !== "completed" && call.status !== "failed";
	const isError = call.status === "failed";
	let args: Record<string, unknown> = input;
	let renderer: ToolRenderers | undefined;
	if (call.kind === "execute") {
		renderer = renderers.bash;
		args = { command: displayText(String(input.command ?? input.command_line ?? call.title ?? call.toolCallId)) };
	} else if (call.kind === "read" && typeof path === "string") {
		renderer = renderers.read;
		args = { ...input, path: displayText(path) };
	} else if (call.kind === "edit" && typeof path === "string") {
		renderer = renderers.edit;
		// Never ask the edit renderer to preview against the local filesystem.
		args = { path: displayText(path) };
	}
	const context = {
		args, toolCallId: call.toolCallId, cwd, expanded, isPartial, isError,
		executionStarted: false, argsComplete: true, showImages: false, durationMs: undefined,
		// The activity gutter supplies the indentation.
		outputPad: 0, state: {}, lastComponent: undefined, invalidate() {},
	};
	const header = renderer?.renderCall?.(args, theme, context) ??
		new Text(theme.fg("toolTitle", theme.bold(displayText(call.title ?? call.toolCallId))), 0, 0);
	const statusColor = isError ? "error" : isPartial ? "border" : "success";
	const lines = gutter(header, 2, theme.fg(statusColor, "⏺"), width);
	const output = toolOutput(activity);
	if (output) {
		// Bash's result renderer supplies Pi's width-aware output preview and
		// expansion hint. It also suits tools without a Pi-specific result shape.
		const resultRenderer = call.kind === "read" ? renderers.read : renderers.bash;
		const component = resultRenderer.renderResult?.(
			{ content: [{ type: "text", text: output }], details: undefined },
			{ expanded, isPartial }, theme, context,
		);
		if (component) lines.push(...gutter(component, 5, `  ${theme.fg("dim", "⎿")}`, width));
	}
	for (const item of call.content ?? []) {
		// Generated images arrive inline in the tool content.
		if (item.type !== "content" || item.content.type !== "image") continue;
		let image = images.get(item.content);
		if (!image) {
			image = new Image(item.content.data, item.content.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 60 });
			images.set(item.content, image);
		}
		lines.push(...gutter(image, 5, `  ${theme.fg("dim", "⎿")}`, width));
	}
	for (const item of call.content ?? []) {
		if (item.type !== "diff") continue;
		const patch = structuredPatch(item.path, item.path, item.oldText ?? "", item.newText, undefined, undefined, { context: 3 });
		const diff = (patch?.hunks ?? []).flatMap((hunk) => {
			let oldLine = hunk.oldStart;
			let newLine = hunk.newStart;
			return hunk.lines.map((line) => {
				const prefix = line[0];
				if (prefix === "+") return `+${newLine++} ${displayText(line.slice(1))}`;
				if (prefix === "-") return `-${oldLine++} ${displayText(line.slice(1))}`;
				if (prefix === " ") {
					oldLine++;
					return ` ${newLine++} ${displayText(line.slice(1))}`;
				}
				return displayText(line);
			});
		});
		const preview = expanded ? diff : diff.slice(0, 6);
		let text = `${theme.fg("accent", displayText(item.path))}\n${renderDiff(preview.join("\n"))}`;
		if (preview.length < diff.length) text += `\n${theme.fg("muted", `… +${diff.length - preview.length} lines (expand to view)`)}`;
		lines.push(...gutter(new Text(text, 0, 0), 5, `  ${theme.fg("dim", "⎿")}`, width));
	}
	if (expanded) {
		const details = new Text(theme.fg("muted", `ACP details\n${JSON.stringify(activity, null, 2)}`), 0, 0);
		lines.push(...gutter(details, 5, `  ${theme.fg("dim", "⎿")}`, width));
	}
	return lines;
}

/** Match Pi's tool call/result gutters while keeping wrapped lines aligned. */
function gutter(component: Component, indent: number, marker: string, width: number): string[] {
	if (width <= 0) return [];
	indent = Math.min(indent, width - 1);
	marker = truncateToWidth(marker, indent, "");
	const lines = component.render(Math.max(1, width - indent));
	const start = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
	if (start < 0) return [];
	return lines.slice(start).map((line, index) => truncateToWidth(
		(index === 0 ? marker + " ".repeat(Math.max(0, indent - visibleWidth(marker))) : " ".repeat(indent)) + line,
		width, "",
	));
}

function toolOutput(activity: AcpToolActivity): string {
	const texts: string[] = [];
	for (const item of activity.toolCall.content ?? []) {
		if (item.type === "content") {
			if (item.content.type === "text") texts.push(item.content.text);
			else if (item.content.type === "resource" && "text" in item.content.resource) texts.push(item.content.resource.text);
			else if (item.content.type !== "image") texts.push(`[${item.content.type}]`);
		} else if (item.type === "terminal") texts.push(`[terminal: ${item.terminalId}]`);
	}
	if (texts.length === 0 && activity.toolCall.rawOutput !== undefined) {
		const raw = activity.toolCall.rawOutput;
		const output = record(raw);
		texts.push(typeof raw === "string" ? raw :
			typeof output.stdout === "string" ? output.stdout + (typeof output.stderr === "string" ? output.stderr : "") :
			JSON.stringify(raw, null, 2));
	}
	return displayText(texts.join("\n"));
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayText(value: string): string {
	return stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
