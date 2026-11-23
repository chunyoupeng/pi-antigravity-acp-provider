import fs from "node:fs";
import path from "node:path";
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
export interface CompactDiff {
	path: string;
	lines: string[];
}
export interface ToolActivityEntry extends AcpToolActivity {
	/** One display row per invocation; ACP IDs can be reused in later turns. */
	rowId: string;
	/** Receipt time of the first notification. */
	observedAt?: number;
	/** Pre-computed compact diff lines so full oldText/newText files are not persisted or re-diffed per frame. */
	diffs?: CompactDiff[];
	/** Line count inferred for native read_file calls that omit file text in ACP updates. */
	readLines?: number;
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
			const restored: ToolActivityEntry = {
				...data,
				observedAt: row?.latest.observedAt ?? data.observedAt ?? Date.parse(entry.timestamp),
			};
			if (row) row.latest = restored;
			else rows.set(data.rowId, { latest: restored, owner: entry.id });
			activeCalls.set(callKey(data), data.rowId);
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerEntryRenderer<ToolActivityEntry>(TOOL_ACTIVITY_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const rowId = data.rowId ?? entry.id;
		let row = rows.get(rowId);
		if (!row) {
			row = { latest: data, owner: entry.id };
			rows.set(rowId, row);
		}
		row.owner ??= entry.id;
		if (row.owner !== entry.id) return undefined;
		const currentRow = row;
		let cached: { latest: ToolActivityEntry; width: number; expanded: boolean; lines: string[] } | undefined;
		return {
			invalidate() {
				cached = undefined;
			},
			render(width) {
				if (cached && cached.latest === currentRow.latest && cached.width === width && cached.expanded === expanded) {
					return cached.lines;
				}
				const lines = renderToolRow(currentRow.latest, { bash, read, edit }, cwd, expanded, theme, width);
				cached = { latest: currentRow.latest, width, expanded, lines };
				return lines;
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
		const row = rows.get(rowId);
		const data = compactActivityEntry(activity, rowId, row?.latest.observedAt ?? Date.now(), cwd);
		if (row) row.latest = data;
		else rows.set(rowId, { latest: data });
		pi.appendEntry(TOOL_ACTIVITY_ENTRY, data);
	};
}

/** One component per image block, so re-renders reuse the terminal image. */
const images = new WeakMap<object, Image>();
/** Lazy cache for legacy persisted entries that still contain raw oldText/newText diffs. */
const legacyDiffCache = new WeakMap<object, CompactDiff[]>();
const MAX_LOCAL_LINE_COUNT_BYTES = 512 * 1024;

function computeDiffLines(filePath: string, oldText: string | null | undefined, newText: string): string[] {
	const patch = structuredPatch(filePath, filePath, oldText ?? "", newText, undefined, undefined, { context: 3 });
	return (patch?.hunks ?? []).flatMap((hunk) => {
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
}

function stripDiffContent<T extends { content?: AcpToolActivity["toolCall"]["content"] }>(container: T): T {
	if (!Array.isArray(container.content) || !container.content.some((item) => item.type === "diff")) {
		return container;
	}
	const filtered = container.content.filter((item) => item.type !== "diff");
	return {
		...container,
		content: filtered,
	};
}

function inferReadLines(activity: AcpToolActivity, cwd: string): number | undefined {
	const call = activity.toolCall;
	if (call.kind !== "read" || call.status !== "completed") return undefined;
	if (toolOutput(activity)) return undefined;
	const input = record(call.rawInput);
	const start = input.StartLine ?? input.start_line ?? input.offset;
	const end = input.EndLine ?? input.end_line;
	const limit = input.limit;
	if (typeof start === "number" && typeof end === "number" && end >= start) {
		return end - start + 1;
	}
	if (typeof limit === "number" && limit > 0) {
		return limit;
	}
	const rawPath =
		input.path ?? input.Path ?? input.file_path ?? input.filePath ?? input.AbsolutePath ?? input.absolute_path ??
		call.locations?.[0]?.path;
	if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
	try {
		const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
		const stat = fs.statSync(resolved);
		if (!stat.isFile() || stat.size > MAX_LOCAL_LINE_COUNT_BYTES) return undefined;
		const buf = fs.readFileSync(resolved);
		// Skip likely binary files (NUL byte in first 8 KiB).
		const sampleEnd = Math.min(buf.length, 8192);
		for (let i = 0; i < sampleEnd; i++) {
			if (buf[i] === 0) return undefined;
		}
		if (buf.length === 0) return 0;
		let lines = 1;
		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === 0x0a) lines += 1;
		}
		if (buf[buf.length - 1] === 0x0a) lines -= 1;
		return lines;
	} catch {
		return undefined;
	}
}

function compactActivityEntry(
	activity: AcpToolActivity,
	rowId: string,
	observedAt: number,
	cwd: string,
): ToolActivityEntry {
	const rawDiffs = (activity.toolCall.content ?? []).filter(
		(item): item is Extract<NonNullable<AcpToolActivity["toolCall"]["content"]>[number], { type: "diff" }> =>
			item.type === "diff",
	);
	const diffs = rawDiffs.length > 0
		? rawDiffs.map((item) => ({ path: item.path, lines: computeDiffLines(item.path, item.oldText, item.newText) }))
		: undefined;
	const readLines = inferReadLines(activity, cwd);
	const toolCall = diffs ? stripDiffContent(activity.toolCall) : activity.toolCall;
	const update = diffs && "content" in activity.update ? stripDiffContent(activity.update) : activity.update;
	return {
		...activity,
		update,
		toolCall,
		rowId,
		observedAt,
		...(diffs ? { diffs } : {}),
		...(readLines !== undefined ? { readLines } : {}),
	};
}

function entryDiffs(activity: ToolActivityEntry): CompactDiff[] {
	if (activity.diffs) return activity.diffs;
	const call = activity.toolCall;
	const rawDiffs = (call.content ?? []).filter(
		(item): item is Extract<NonNullable<AcpToolActivity["toolCall"]["content"]>[number], { type: "diff" }> =>
			item.type === "diff",
	);
	if (rawDiffs.length === 0) return [];
	let cached = legacyDiffCache.get(call);
	if (!cached) {
		cached = rawDiffs.map((item) => ({ path: item.path, lines: computeDiffLines(item.path, item.oldText, item.newText) }));
		legacyDiffCache.set(call, cached);
	}
	return cached;
}

function callKey(activity: AcpToolActivity): string {
	return JSON.stringify([activity.sessionId, activity.toolCall.toolCallId]);
}

function renderToolRow(
	activity: ToolActivityEntry,
	renderers: { bash: ToolRenderers; read: ToolRenderers; edit: ToolRenderers },
	cwd: string,
	expanded: boolean,
	theme: Theme,
	width: number,
): string[] {
	const call = activity.toolCall;
	const input = record(call.rawInput);
	const diffs = entryDiffs(activity);
	const filePath = input.path ?? input.Path ?? input.file_path ?? input.filePath ?? input.AbsolutePath ?? input.absolute_path ?? call.locations?.[0]?.path ??
		diffs[0]?.path;
	const isPartial = call.status !== "completed" && call.status !== "failed";
	const isError = call.status === "failed";
	let args: Record<string, unknown> = input;
	let renderer: ToolRenderers | undefined;
	if (call.kind === "execute") {
		renderer = renderers.bash;
		args = { command: displayText(String(input.command ?? input.CommandLine ?? input.command_line ?? call.title ?? call.toolCallId)) };
	} else if (call.kind === "read" && typeof filePath === "string") {
		renderer = renderers.read;
		const start = input.StartLine ?? input.start_line;
		const end = input.EndLine ?? input.end_line;
		args = {
			...input, path: displayText(filePath),
			...(typeof start === "number" ? { offset: start } : {}),
			...(typeof start === "number" && typeof end === "number" ? { limit: end - start + 1 } : {}),
		};
	} else if (call.kind === "edit" && typeof filePath === "string") {
		renderer = renderers.edit;
		args = { path: displayText(filePath) };
	}
	const context = {
		args, toolCallId: call.toolCallId, cwd, expanded, isPartial, isError,
		executionStarted: false, argsComplete: true, showImages: false, durationMs: undefined,
		outputPad: 0, state: {}, lastComponent: undefined, invalidate() {},
	};
	const header = renderer?.renderCall?.(args, theme, context) ??
		new Text(theme.fg("toolTitle", theme.bold(displayText(call.title ?? call.toolCallId))), 0, 0);
	const statusColor = isError ? "error" : isPartial ? "border" : "success";
	const lines = gutter(header, 2, theme.fg(statusColor, "⏺"), width);
	const output = toolOutput(activity);
	if (output) {
		const resultRenderer = call.kind === "read" ? renderers.read : renderers.bash;
		const component = resultRenderer.renderResult?.(
			{ content: [{ type: "text", text: output }], details: undefined },
			{ expanded, isPartial }, theme, context,
		);
		if (component) lines.push(...gutter(component, 5, `  ${theme.fg("dim", "⎿")}`, width));
	} else if (call.kind === "read" && call.status === "completed" && activity.readLines !== undefined) {
		const count = activity.readLines;
		const summary = new Text(theme.fg("muted", `Read ${count} ${count === 1 ? "line" : "lines"}`), 0, 0);
		lines.push(...gutter(summary, 5, `  ${theme.fg("dim", "⎿")}`, width));
	}
	for (const item of call.content ?? []) {
		if (item.type !== "content" || item.content.type !== "image") continue;
		let image = images.get(item.content);
		if (!image) {
			image = new Image(item.content.data, item.content.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 60 });
			images.set(item.content, image);
		}
		lines.push(...gutter(image, 5, `  ${theme.fg("dim", "⎿")}`, width));
	}
	for (const item of diffs) {
		const diffBody = renderDiff(item.lines.join("\n"), { filePath: item.path });
		const showPathHeader = diffs.length > 1 || item.path !== filePath;
		const text = showPathHeader
			? `${theme.fg("accent", displayText(item.path))}\n${diffBody}`
			: diffBody;
		lines.push(...gutter(new Text(text, 0, 0), 5, `  ${theme.fg("dim", "⎿")}`, width));
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

function cleanExecuteOutput(text: string): string {
	let cleaned = text.replace(/^(?:(?:Created|Completed) At:[^\n]*\n)+/u, "");
	cleaned = cleaned.replace(/^Command exited with code 0\.\n+(?:Command output:\n)?/u, "");
	if (cleaned.trim() === "No output from the command.") return "(no output)";
	return cleaned;
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
	if (texts.length === 0 && activity.toolCall.rawOutput !== undefined && activity.toolCall.rawOutput !== null) {
		const raw = activity.toolCall.rawOutput;
		if (typeof raw === "string") {
			if (raw.length > 0) texts.push(raw);
		} else if (typeof raw === "object" && !Array.isArray(raw)) {
			const output = record(raw);
			if (typeof output.stdout === "string") {
				texts.push(output.stdout + (typeof output.stderr === "string" ? output.stderr : ""));
			} else if (typeof output.output === "string") {
				texts.push(output.output);
			} else if (Object.keys(output).length > 0) {
				texts.push(JSON.stringify(raw, null, 2));
			}
		} else {
			texts.push(JSON.stringify(raw, null, 2));
		}
	}
	const joined = displayText(texts.join("\n"));
	return activity.toolCall.kind === "execute" ? cleanExecuteOutput(joined) : joined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayText(value: string): string {
	return stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
