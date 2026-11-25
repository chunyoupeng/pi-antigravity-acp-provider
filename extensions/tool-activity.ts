import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createBashToolDefinition,
	createReadToolDefinition,
	createEditToolDefinition,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingHints,
	type Theme,
	type ToolRenderers,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import { type Component, Image, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { structuredPatch } from "diff";

import type { AcpToolActivity } from "../src/acp/events.js";

export const TOOL_ACTIVITY_ENTRY = "antigravity-acp-tool-activity";
export const TOOL_DIVIDER_ENTRY = "antigravity-acp-tool-divider";
const NON_COLLAPSIBLE_KINDS = new Set<string>(["read", "edit"]);
export interface CompactDiff {
	path: string;
	lines: string[];
}
export interface ToolActivityEntry extends AcpToolActivity {
	/** One display row per invocation; ACP IDs can be reused in later turns. */
	rowId: string;
	/** Receipt time of the first notification. */
	observedAt?: number;
	/** Measured execution duration in milliseconds once completed or failed. */
	durationMs?: number;
	/** Pre-computed compact diff lines so full oldText/newText files are not persisted or re-diffed per frame. */
	diffs?: CompactDiff[];
	/** Line count inferred for native read_file calls that omit file text in ACP updates. */
	readLines?: number;
}

interface ToolRow {
	latest: ToolActivityEntry;
	owner?: string;
	previewCollapsed: boolean;
}

interface ReadGroup {
	owner?: string;
	rows: ToolRow[];
	version: number;
	sealed: boolean;
}

export interface RegisterToolActivityOptions {
	collapseToolOutput?: () => boolean;
	outputPad?: () => number;
}

function isCollapsibleKind(kind: AcpToolActivity["toolCall"]["kind"]): boolean {
	return !kind || !NON_COLLAPSIBLE_KINDS.has(kind);
}

interface CollapseSettingsReader {
	getCollapseToolOutput?: () => boolean;
}

function readCollapseToolOutput(cwd: string): boolean {
	try {
		const settings = SettingsManager.create(cwd) as CollapseSettingsReader;
		return settings.getCollapseToolOutput?.() ?? true;
	} catch {
		return true;
	}
}

function readOutputPad(cwd: string): number {
	try {
		return SettingsManager.create(cwd).getOutputPad();
	} catch {
		return 1;
	}
}

/** Display-only session entries: never queued as model input or executable Pi calls. */
export function registerToolActivity(
	pi: ExtensionAPI,
	options?: RegisterToolActivityOptions,
): (activity: AcpToolActivity) => void {
	const rows = new Map<string, ToolRow>();
	const readGroups = new Map<string, ReadGroup>();
	const activeCalls = new Map<string, string>();
	const turnRows = new Set<ToolRow>();
	let activeReadGroup: ReadGroup | undefined;
	let cwd = process.cwd();
	let outputPad = options?.outputPad ? options.outputPad() : readOutputPad(cwd);
	let pendingAcpTool = false;
	let piWillAddDivider = false;
	const shouldCollapse = () => (options?.collapseToolOutput ? options.collapseToolOutput() : readCollapseToolOutput(cwd));
	const sealReadGroup = () => {
		if (activeReadGroup) {
			activeReadGroup.sealed = true;
			activeReadGroup = undefined;
		}
	};
	const attachToReadGroup = (rowId: string, row: ToolRow, owner?: string) => {
		let group = activeReadGroup;
		if (!group || group.sealed) {
			group = { ...(owner !== undefined ? { owner } : {}), rows: [], version: 0, sealed: false };
			activeReadGroup = group;
		}
		group.rows.push(row);
		group.version += 1;
		readGroups.set(rowId, group);
	};
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
		readGroups.clear();
		activeCalls.clear();
		turnRows.clear();
		activeReadGroup = undefined;
		pendingAcpTool = false;
		piWillAddDivider = false;
		cwd = ctx.cwd;
		outputPad = options?.outputPad ? options.outputPad() : readOutputPad(cwd);
		const collapse = shouldCollapse();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === TOOL_DIVIDER_ENTRY) {
				sealReadGroup();
				continue;
			}
			if (entry.type === "message") {
				const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
				if (msg?.role === "user" || msg?.role === "toolResult") {
					sealReadGroup();
				} else if (msg?.role === "assistant") {
					const content = Array.isArray(msg.content) ? msg.content : [];
					const hasVisible = content.some(
						(block: { type?: string; text?: string }) =>
							block.type === "toolCall" || (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0),
					);
					if (hasVisible) sealReadGroup();
				}
				continue;
			}
			if (entry.type !== "custom" || entry.customType !== TOOL_ACTIVITY_ENTRY) continue;
			const data = entry.data as ToolActivityEntry | undefined;
			if (!data?.rowId) continue;
			const row = rows.get(data.rowId);
			const finished = data.toolCall.status === "completed" || data.toolCall.status === "failed";
			const observedAt = row?.latest.observedAt ?? data.observedAt ?? Date.parse(entry.timestamp);
			const durationMs =
				data.durationMs ??
				row?.latest.durationMs ??
				(finished && data.toolCall.kind === "execute" ? parseExecuteDurationMs(rawToolText(data)) : undefined);
			const restored: ToolActivityEntry = {
				...data,
				observedAt,
				...(durationMs !== undefined ? { durationMs } : {}),
			};
			const previewCollapsed = collapse && finished && isCollapsibleKind(restored.toolCall.kind);
			if (row) {
				row.latest = restored;
				row.previewCollapsed = previewCollapsed;
				const group = readGroups.get(data.rowId);
				if (group) group.version += 1;
			} else {
				const nextRow: ToolRow = { latest: restored, owner: entry.id, previewCollapsed };
				rows.set(data.rowId, nextRow);
				if (restored.toolCall.kind === "read") {
					attachToReadGroup(data.rowId, nextRow, entry.id);
				} else {
					sealReadGroup();
				}
			}
			activeCalls.set(callKey(data), data.rowId);
		}
		sealReadGroup();
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("message_start", (event) => {
		if (event.message.role === "user") {
			sealReadGroup();
			pendingAcpTool = false;
			piWillAddDivider = false;
		}
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const content = Array.isArray(event.message.content) ? event.message.content : [];
		const hasToolCall = content.some((block) => block.type === "toolCall");
		const hasText = content.some((block) => block.type === "text" && block.text.trim().length > 0);
		if (hasToolCall || hasText) {
			sealReadGroup();
		}
		if (pendingAcpTool && !piWillAddDivider && !hasToolCall && hasText) {
			pi.appendEntry(TOOL_DIVIDER_ENTRY, {});
			pendingAcpTool = false;
		}
		if (hasToolCall) {
			piWillAddDivider = true;
			pendingAcpTool = false;
		} else if (hasText) {
			piWillAddDivider = false;
			pendingAcpTool = false;
		}
	});
	pi.on("agent_end", () => {
		sealReadGroup();
		if (shouldCollapse()) {
			for (const row of turnRows) {
				if (isCollapsibleKind(row.latest.toolCall.kind)) {
					row.previewCollapsed = true;
				}
			}
		}
		turnRows.clear();
	});

	pi.registerEntryRenderer<ToolActivityEntry>(TOOL_ACTIVITY_ENTRY, (entry, renderOptions, theme) => {
		const { expanded } = renderOptions;
		const keyHints: KeybindingHints = {
			keyText: renderOptions.keyText ?? (() => ""),
			keyHint: renderOptions.keyHint ?? ((_key, description) => description),
		};
		const data = entry.data;
		if (!data) return undefined;
		const rowId = data.rowId ?? entry.id;
		let row = rows.get(rowId);
		if (!row) {
			row = { latest: data, owner: entry.id, previewCollapsed: false };
			rows.set(rowId, row);
			if (data.toolCall.kind === "read") {
				const standaloneGroup: ReadGroup = { owner: entry.id, rows: [row], version: 1, sealed: true };
				readGroups.set(rowId, standaloneGroup);
			}
		}
		const group = readGroups.get(rowId);
		if (group) {
			group.owner ??= entry.id;
			if (group.owner !== entry.id) return undefined;
			const currentGroup = group;
			let cachedGroup:
				| {
					version: number;
					width: number;
					expanded: boolean;
					previewCollapsed: boolean;
					lines: string[];
				}
				| undefined;
			return {
				invalidate() {
					cachedGroup = undefined;
				},
				render(width) {
					const groupCollapsed = currentGroup.rows.every((item) => item.previewCollapsed);
					if (
						cachedGroup &&
						cachedGroup.version === currentGroup.version &&
						cachedGroup.width === width &&
						cachedGroup.expanded === expanded &&
						cachedGroup.previewCollapsed === groupCollapsed
					) {
						return cachedGroup.lines;
					}
					const lines = renderReadGroup(
						currentGroup.rows.map((item) => item.latest),
						read,
						cwd,
						expanded,
						groupCollapsed,
						keyHints,
						theme,
						width,
					);
					cachedGroup = { version: currentGroup.version, width, expanded, previewCollapsed: groupCollapsed, lines };
					return lines;
				},
			} satisfies Component;
		}
		row.owner ??= entry.id;
		if (row.owner !== entry.id) return undefined;
		const currentRow = row;
		let cached:
			| {
				latest: ToolActivityEntry;
				width: number;
				expanded: boolean;
				previewCollapsed: boolean;
				elapsedBucket: number | undefined;
				lines: string[];
			}
			| undefined;
		return {
			invalidate() {
				cached = undefined;
			},
			render(width) {
				const latest = currentRow.latest;
				const isTimedKind = latest.toolCall.kind !== "read" && latest.toolCall.kind !== "edit";
				const isRunningTimed =
					isTimedKind &&
					latest.toolCall.status !== "completed" &&
					latest.toolCall.status !== "failed" &&
					latest.observedAt !== undefined;
				const elapsedBucket = isRunningTimed
					? Math.floor(Math.max(0, Date.now() - latest.observedAt!) / 1000)
					: undefined;
				if (
					cached &&
					cached.latest === latest &&
					cached.width === width &&
					cached.expanded === expanded &&
					cached.previewCollapsed === currentRow.previewCollapsed &&
					cached.elapsedBucket === elapsedBucket
				) {
					return cached.lines;
				}
				const lines = renderToolRow(
					latest,
					{ bash, read, edit },
					cwd,
					expanded,
					currentRow.previewCollapsed,
					keyHints,
					theme,
					width,
				);
				cached = { latest, width, expanded, previewCollapsed: currentRow.previewCollapsed, elapsedBucket, lines };
				return lines;
			},
		} satisfies Component;
	});

	pi.registerEntryRenderer(TOOL_DIVIDER_ENTRY, (_entry, _options, theme) => ({
		invalidate() {},
		render(width) {
			if (width <= 0) return [];
			const pad = Math.min(outputPad, Math.max(0, Math.floor((width - 1) / 2)));
			const contentWidth = Math.max(1, width - pad * 2);
			return [" ".repeat(pad) + theme.fg("mdHr", "─".repeat(Math.min(contentWidth, 80)))];
		},
	}));

	return (activity) => {
		pendingAcpTool = true;
		const key = callKey(activity);
		let rowId = activeCalls.get(key);
		if (!rowId || activity.update.sessionUpdate === "tool_call") {
			rowId = crypto.randomUUID();
			activeCalls.set(key, rowId);
		}
		let row = rows.get(rowId);
		const now = Date.now();
		const observedAt = row?.latest.observedAt ?? now;
		const finished = activity.toolCall.status === "completed" || activity.toolCall.status === "failed";
		let durationMs = row?.latest.durationMs;
		if (finished && durationMs === undefined) {
			if (row) {
				durationMs = Math.max(0, now - observedAt);
			} else if (activity.toolCall.kind === "execute") {
				durationMs = parseExecuteDurationMs(rawToolText(activity));
			}
		}
		const data = compactActivityEntry(activity, rowId, observedAt, durationMs, cwd);
		if (row) {
			row.latest = data;
			row.previewCollapsed = false;
			const group = readGroups.get(rowId);
			if (group) group.version += 1;
		} else {
			row = { latest: data, previewCollapsed: false };
			rows.set(rowId, row);
			if (activity.toolCall.kind === "read") {
				attachToReadGroup(rowId, row);
			} else {
				sealReadGroup();
			}
		}
		turnRows.add(row);
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
	durationMs: number | undefined,
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
		...(durationMs !== undefined ? { durationMs } : {}),
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

function formatReadDisplayPath(rawPath: string, cwd: string): string {
	const cleaned = displayText(rawPath);
	if (!cleaned) return "";
	if (path.isAbsolute(cleaned)) {
		const rel = path.relative(cwd, cleaned);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			return rel;
		}
		const home = os.homedir();
		if (home && (cleaned === home || cleaned.startsWith(`${home}${path.sep}`))) {
			return `~${cleaned.slice(home.length)}`;
		}
	}
	return cleaned;
}

function formatReadRange(input: Record<string, unknown>): string {
	const start = input.StartLine ?? input.start_line ?? input.offset;
	const end = input.EndLine ?? input.end_line;
	const limit = input.limit;
	if (typeof start === "number" && typeof end === "number" && end >= start) {
		return `:${start}-${end}`;
	}
	if (typeof start === "number" && typeof limit === "number" && limit > 0) {
		return `:${start}-${start + limit - 1}`;
	}
	if (typeof start === "number") {
		return `:${start}`;
	}
	return "";
}

function renderReadGroup(
	entries: ToolActivityEntry[],
	readRenderer: ToolRenderers,
	cwd: string,
	expanded: boolean,
	previewCollapsed: boolean,
	keyHints: KeybindingHints,
	theme: Theme,
	width: number,
): string[] {
	if (entries.length === 0) return [];
	const count = entries.length;
	const noun = count === 1 ? "file" : "files";
	const isInProgress = entries.some((entry) => entry.toolCall.status !== "completed" && entry.toolCall.status !== "failed");
	const hasError = entries.some((entry) => entry.toolCall.status === "failed");
	const label = isInProgress ? `Reading ${count} ${noun}...` : `Read ${count} ${noun}`;
	const statusColor = isInProgress ? "border" : hasError ? "error" : "success";
	const lines = gutter(new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0), 2, theme.fg(statusColor, "⏺"), width);

	for (const entry of entries) {
		const call = entry.toolCall;
		const input = record(call.rawInput);
		const rawPath =
			input.path ?? input.Path ?? input.file_path ?? input.filePath ??
			input.AbsolutePath ?? input.absolute_path ?? call.locations?.[0]?.path;
		const filePath = typeof rawPath === "string" && rawPath.trim() ? formatReadDisplayPath(rawPath, cwd) : displayText(call.title ?? call.toolCallId);
		const range = formatReadRange(input);
		const isPartial = call.status !== "completed" && call.status !== "failed";
		const isError = call.status === "failed";
		let entryLine = theme.fg("muted", `${filePath}${range}`);
		const output = toolOutput(entry);
		if (!expanded && isError) {
			const firstErrorLine = output
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0);
			const summary = firstErrorLine ? truncateToWidth(firstErrorLine, 80, "…") : "error";
			entryLine += ` ${theme.fg("error", summary)}`;
		}
		lines.push(...gutter(new Text(entryLine, 0, 0), 5, `  ${theme.fg("dim", "└─")}`, width));

		if (expanded) {
			const start = input.StartLine ?? input.start_line ?? input.offset;
			const end = input.EndLine ?? input.end_line;
			const args = {
				...input,
				path: displayText(typeof rawPath === "string" ? rawPath : filePath),
				...(typeof start === "number" ? { offset: start } : {}),
				...(typeof start === "number" && typeof end === "number" ? { limit: end - start + 1 } : {}),
			};
			if (output) {
				const context = {
					args, toolCallId: call.toolCallId, cwd, expanded: true, isPartial, isError,
					executionStarted: false, argsComplete: true, showImages: false, durationMs: undefined,
					outputPad: 0, state: {}, lastComponent: undefined, invalidate() {},
					keyText: keyHints.keyText, keyHint: keyHints.keyHint,
				};
				const component = readRenderer.renderResult?.(
					{ content: [{ type: "text", text: output }], details: undefined },
					{ expanded: true, isPartial },
					theme,
					context,
				);
				if (component) lines.push(...gutter(component, 5, "     ", width));
			} else if (call.status === "completed" && entry.readLines !== undefined) {
				const lineCount = entry.readLines;
				const summary = new Text(theme.fg("muted", `Read ${lineCount} ${lineCount === 1 ? "line" : "lines"}`), 0, 0);
				lines.push(...gutter(summary, 5, "     ", width));
			}
		}

		if (!previewCollapsed || expanded) {
			for (const item of call.content ?? []) {
				if (item.type !== "content" || item.content.type !== "image") continue;
				let image = images.get(item.content);
				if (!image) {
					image = new Image(item.content.data, item.content.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 60 });
					images.set(item.content, image);
				}
				lines.push(...gutter(image, 5, "     ", width));
			}
		}
	}

	return lines;
}

function renderToolRow(
	activity: ToolActivityEntry,
	renderers: { bash: ToolRenderers; read: ToolRenderers; edit: ToolRenderers },
	cwd: string,
	expanded: boolean,
	previewCollapsed: boolean,
	keyHints: KeybindingHints,
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
	const durationMs = !isPartial ? activity.durationMs : undefined;
	const context = {
		args, toolCallId: call.toolCallId, cwd, expanded, isPartial, isError,
		executionStarted: false, argsComplete: true, showImages: false, durationMs,
		outputPad: 0, state: {}, lastComponent: undefined, invalidate() {},
		keyText: keyHints.keyText, keyHint: keyHints.keyHint,
	};
	const header = renderer?.renderCall?.(args, theme, context) ??
		new Text(formatGenericToolCall(displayText(call.title ?? call.toolCallId), call.rawInput, theme, expanded), 0, 0);
	const statusColor = isError ? "error" : isPartial ? "border" : "success";
	const lines = gutter(header, 2, theme.fg(statusColor, "⏺"), width);
	const showTiming = call.kind === "execute" || !renderer;
	if (previewCollapsed && !expanded) {
		if (showTiming && durationMs !== undefined && lines.length > 0) {
			const suffix = ` ${theme.fg("muted", `(${formatDuration(durationMs)})`)}`;
			const lastIdx = lines.length - 1;
			const lastLine = lines[lastIdx]!.trimEnd();
			if (visibleWidth(lastLine) + visibleWidth(suffix) <= width) {
				lines[lastIdx] = lastLine + suffix;
			} else if (visibleWidth(suffix) < width) {
				lines[lastIdx] = truncateToWidth(lastLine, Math.max(1, width - visibleWidth(suffix)), "…") + suffix;
			}
		}
		return lines;
	}
	const output = toolOutput(activity);
	if (output) {
		let component: Component | undefined;
		if (!renderer) {
			component = renderGenericResult(output, expanded, isError, durationMs, keyHints, theme);
		} else {
			const resultRenderer = call.kind === "read" ? renderers.read : renderers.bash;
			component = resultRenderer.renderResult?.(
				{ content: [{ type: "text", text: output }], details: undefined },
				{ expanded, isPartial }, theme, context,
			);
		}
		if (component) lines.push(...gutter(component, 5, `  ${theme.fg("dim", "⎿")}`, width));
		if (showTiming && isPartial && activity.observedAt !== undefined) {
			const elapsed = new Text(theme.fg("muted", `Elapsed ${formatDuration(Date.now() - activity.observedAt)}`), 0, 0);
			lines.push(...gutter(elapsed, 5, "     ", width));
		}
	} else if (showTiming && isPartial && activity.observedAt !== undefined) {
		const elapsed = new Text(theme.fg("muted", `Elapsed ${formatDuration(Date.now() - activity.observedAt)}`), 0, 0);
		lines.push(...gutter(elapsed, 5, `  ${theme.fg("dim", "⎿")}`, width));
	} else if (call.kind === "execute" && durationMs !== undefined) {
		const component = renderers.bash.renderResult?.(
			{ content: [], details: undefined },
			{ expanded, isPartial }, theme, context,
		);
		if (component) lines.push(...gutter(component, 5, `  ${theme.fg("dim", "⎿")}`, width));
	} else if (!renderer && durationMs !== undefined) {
		const summary = new Text(theme.fg("muted", `Took ${formatDuration(durationMs)}`), 0, 0);
		lines.push(...gutter(summary, 5, `  ${theme.fg("dim", "⎿")}`, width));
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

const GENERIC_ARGS_PREVIEW_CHARS = 100;
const GENERIC_RESULT_PREVIEW_LINES = 5;

function formatGenericToolCall(title: string, rawInput: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (rawInput == null) return header;
	const entries: Array<[string, unknown]> =
		typeof rawInput === "object" && !Array.isArray(rawInput)
			? Object.entries(rawInput).filter(([, value]) => value !== undefined)
			: [["args", rawInput]];
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const raw = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			const clean = displayText(raw).replace(/\t/g, "   ").replace(/\r/g, "");
			return `  ${displayText(key)}: ${clean.split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const compactEntries = entries.filter(([, value]) => value !== "");
	if (compactEntries.length === 0) return header;
	const pairs = compactEntries
		.map(([key, value]) => {
			const serialized = typeof value === "string"
				? JSON.stringify(displayText(value))
				: displayText(JSON.stringify(value) ?? String(value));
			return `${displayText(key)}=${serialized}`;
		})
		.join(" ");
	const preview = pairs.length > GENERIC_ARGS_PREVIEW_CHARS
		? `${pairs.slice(0, GENERIC_ARGS_PREVIEW_CHARS - 3)}...`
		: pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

function renderGenericResult(
	output: string,
	expanded: boolean,
	isError: boolean,
	durationMs: number | undefined,
	keyHints: KeybindingHints,
	theme: Theme,
): Component {
	const rawLines = output.replace(/\r/g, "").split("\n");
	const shown = expanded ? rawLines : rawLines.slice(0, GENERIC_RESULT_PREVIEW_LINES);
	const remaining = rawLines.length - shown.length;
	const color = isError ? "error" : "toolOutput";
	const renderedLines = shown.map((line) => theme.fg(color, line.replace(/\t/g, "   ")));
	if (remaining > 0) {
		const noun = remaining === 1 ? "line" : "lines";
		renderedLines.push(
			`${theme.fg("muted", `... (${remaining} more ${noun},`)} ${keyHints.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
		);
	}
	if (durationMs !== undefined) {
		renderedLines.push(theme.fg("muted", `Took ${formatDuration(durationMs)}`));
	}
	return new Text(renderedLines.join("\n"), 0, 0);
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

function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function parseExecuteDurationMs(text: string): number | undefined {
	const created = /^Created At:\s*([^\n]+)$/mu.exec(text)?.[1]?.trim();
	const completed = /^Completed At:\s*([^\n]+)$/mu.exec(text)?.[1]?.trim();
	if (!created || !completed) return undefined;
	const start = Date.parse(created);
	const end = Date.parse(completed);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
	return end - start;
}

function cleanExecuteOutput(text: string): string {
	let cleaned = text.replace(/^(?:(?:Created|Completed) At:[^\n]*\n)+/u, "");
	cleaned = cleaned.replace(/^Command exited with code 0\.\n+(?:Command output:\n)?/u, "");
	if (cleaned.trim() === "No output from the command.") return "(no output)";
	return cleaned;
}

function rawToolText(activity: AcpToolActivity): string {
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
	return displayText(texts.join("\n"));
}

function toolOutput(activity: AcpToolActivity): string {
	const joined = rawToolText(activity);
	return activity.toolCall.kind === "execute" ? cleanExecuteOutput(joined) : joined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayText(value: string): string {
	return stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
