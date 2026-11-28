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
import { type Component, Image, Text, type TuiMouseEvent, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { structuredPatch } from "diff";

import type { AcpToolActivity } from "../src/acp/events.js";

export const TOOL_ACTIVITY_ENTRY = "antigravity-acp-tool-activity";
/** Edits keep their diff after the turn; reads fold into their group's header like shell commands. */
const NON_COLLAPSIBLE_KINDS = new Set<string>(["edit"]);
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
	/**
	 * Set when assistant text streamed between the previous row and this one. ACP turns stream as one
	 * Pi message, so `message_end` cannot separate read groups; restore uses this flag instead.
	 */
	groupStart?: boolean;
}

/**
 * A row's expanded state chosen by clicking it. It applies only while the global Ctrl+O state is still
 * `global`, so toggling Ctrl+O afterwards takes over again, as it does for Pi's own tool rows.
 */
interface ClickExpansion {
	expanded: boolean;
	global: boolean;
}

interface ToolRow {
	latest: ToolActivityEntry;
	owner?: string;
	previewCollapsed: boolean;
	clicked?: ClickExpansion;
}

interface ReadGroup {
	owner?: string;
	rows: ToolRow[];
	version: number;
	sealed: boolean;
	clicked?: ClickExpansion;
}

/** Expanded state for one render: a click on the row wins until the global Ctrl+O state changes. */
function effectiveExpanded(clicked: ClickExpansion | undefined, globalExpanded: boolean): boolean {
	return clicked && clicked.global === globalExpanded ? clicked.expanded : globalExpanded;
}

/**
 * Full-screen Pi forwards a plain left click to the row under the pointer. Toggle that row like Pi's own
 * tool rows do; returning `handled` makes the TUI redraw.
 */
function toggleOnClick(
	event: TuiMouseEvent,
	target: { clicked?: ClickExpansion },
	globalExpanded: boolean,
): { handled: true } | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
	target.clicked = { expanded: !effectiveExpanded(target.clicked, globalExpanded), global: globalExpanded };
	return { handled: true };
}

export interface RegisterToolActivityOptions {
	collapseToolOutput?: () => boolean;
	/** Left/right padding of chat rows (Pi's `outputPad` setting); rows are indented by it to align with messages. */
	outputPad?: () => number;
}

function isCollapsibleKind(kind: AcpToolActivity["toolCall"]["kind"]): boolean {
	return !kind || !NON_COLLAPSIBLE_KINDS.has(kind);
}

/** Native reads and shell commands in a row share one summary row ("Read 2 files, ran 3 shell commands"). */
const GROUPABLE_KINDS = new Set<string>(["read", "execute"]);

function isGroupableKind(kind: AcpToolActivity["toolCall"]["kind"]): boolean {
	return kind !== undefined && kind !== null && GROUPABLE_KINDS.has(kind);
}

interface CollapseSettingsReader {
	getCollapseToolOutput?: () => boolean;
	getOutputPad?: () => number;
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
		const settings = SettingsManager.create(cwd) as CollapseSettingsReader;
		return settings.getOutputPad?.() ?? 1;
	} catch {
		return 1;
	}
}

/**
 * Custom entries render flush left, while Pi indents messages and its own tool rows by `outputPad`.
 * Indent rows the same way so bullets and text line up; skip it when the terminal is too narrow.
 */
function padRows(render: (innerWidth: number) => string[], width: number, pad: number): string[] {
	const usable = pad > 0 && width > pad * 2 + 2 ? pad : 0;
	const lines = render(width - usable * 2);
	if (usable === 0) return lines;
	const left = " ".repeat(usable);
	return lines.map((line) => `${left}${line}`);
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
	let activeSessionId: string | undefined;
	/** Visible assistant text streamed since the last new row; the next row starts a new read group. */
	let textSinceLastRow = false;
	let cwd = process.cwd();
	const shouldCollapse = () => (options?.collapseToolOutput ? options.collapseToolOutput() : readCollapseToolOutput(cwd));
	/** `collapseToolOutput`, refreshed at session and agent boundaries so renders never read settings from disk. */
	let collapseFinished = shouldCollapse();
	const currentOutputPad = () => (options?.outputPad ? options.outputPad() : readOutputPad(cwd));
	/** `outputPad`, refreshed with `collapseFinished`. */
	let outputPad = currentOutputPad();
	const refreshCollapse = () => {
		collapseFinished = shouldCollapse();
		outputPad = currentOutputPad();
	};
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
		textSinceLastRow = false;
		activeSessionId = ctx.sessionManager.getSessionId?.();
		cwd = ctx.cwd;
		refreshCollapse();
		const collapse = collapseFinished;
		for (const entry of ctx.sessionManager.getBranch()) {
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
				if (restored.groupStart) sealReadGroup();
				if (isGroupableKind(restored.toolCall.kind)) {
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
		if (event.message.role === "user") sealReadGroup();
	});
	// Narration between native tools arrives inside one streaming message; without this, a read after
	// "Now I'll check X" would join the group rendered above that text.
	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" || update.delta.trim().length === 0) return;
		sealReadGroup();
		textSinceLastRow = true;
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const content = Array.isArray(event.message.content) ? event.message.content : [];
		const hasToolCall = content.some((block) => block.type === "toolCall");
		const hasText = content.some((block) => block.type === "text" && block.text.trim().length > 0);
		if (hasToolCall || hasText) {
			sealReadGroup();
		}
	});
	pi.on("agent_start", refreshCollapse);
	pi.on("agent_end", () => {
		sealReadGroup();
		refreshCollapse();
		if (collapseFinished) {
			for (const row of turnRows) {
				if (isCollapsibleKind(row.latest.toolCall.kind)) {
					row.previewCollapsed = true;
				}
			}
		}
		turnRows.clear();
	});

	pi.registerEntryRenderer<ToolActivityEntry>(TOOL_ACTIVITY_ENTRY, (entry, renderOptions, theme) => {
		const { expanded: globalExpanded } = renderOptions;
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
			if (isGroupableKind(data.toolCall.kind)) {
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
					collapsedRows: number;
					elapsedBucket: number | undefined;
					outputPad: number;
					lines: string[];
				}
				| undefined;
			return {
				invalidate() {
					cachedGroup = undefined;
				},
				handleMouse(event: TuiMouseEvent) {
					return toggleOnClick(event, currentGroup, globalExpanded);
				},
				render(width) {
					const expanded = effectiveExpanded(currentGroup.clicked, globalExpanded);
					const collapsedRows = currentGroup.rows.filter((item) => item.previewCollapsed).length;
					const running = currentGroup.rows.some(
						(item) => item.latest.toolCall.kind === "execute" && !isFinished(item.latest),
					);
					const elapsedBucket = running ? Math.floor(Date.now() / 1000) : undefined;
					if (
						cachedGroup &&
						cachedGroup.version === currentGroup.version &&
						cachedGroup.width === width &&
						cachedGroup.expanded === expanded &&
						cachedGroup.collapsedRows === collapsedRows &&
						cachedGroup.elapsedBucket === elapsedBucket &&
						cachedGroup.outputPad === outputPad
					) {
						return cachedGroup.lines;
					}
					// Even a lone shell command renders as a group ("Ran 1 shell command"), like Claude Code.
					const lines = padRows(
						(inner) => renderActivityGroup(currentGroup.rows, { read }, cwd, expanded, keyHints, theme, inner),
						width,
						outputPad,
					);
					cachedGroup = { version: currentGroup.version, width, expanded, collapsedRows, elapsedBucket, outputPad, lines };
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
				outputPad: number;
				lines: string[];
			}
			| undefined;
		return {
			invalidate() {
				cached = undefined;
			},
			handleMouse(event: TuiMouseEvent) {
				return toggleOnClick(event, currentRow, globalExpanded);
			},
			render(width) {
				const expanded = effectiveExpanded(currentRow.clicked, globalExpanded);
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
					cached.elapsedBucket === elapsedBucket &&
					cached.outputPad === outputPad
				) {
					return cached.lines;
				}
				const lines = padRows(
					(inner) => renderToolRow(latest, { bash, read, edit }, cwd, expanded, currentRow.previewCollapsed, keyHints, theme, inner),
					width,
					outputPad,
				);
				cached = { latest, width, expanded, previewCollapsed: currentRow.previewCollapsed, elapsedBucket, outputPad, lines };
				return lines;
			},
		} satisfies Component;
	});

	return (activity) => {
		if (activeSessionId !== undefined && activity.piSessionId !== activeSessionId) {
			return;
		}
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
		const startsGroup = row ? row.latest.groupStart === true : textSinceLastRow;
		const data: ToolActivityEntry = {
			...compactActivityEntry(activity, rowId, observedAt, durationMs, cwd),
			...(startsGroup ? { groupStart: true } : {}),
		};
		if (!row) textSinceLastRow = false;
		if (row) {
			row.latest = data;
			row.previewCollapsed = false;
			const group = readGroups.get(rowId);
			if (group) group.version += 1;
		} else {
			row = { latest: data, previewCollapsed: false };
			rows.set(rowId, row);
			if (isGroupableKind(activity.toolCall.kind)) {
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

function isFinished(entry: ToolActivityEntry): boolean {
	return entry.toolCall.status === "completed" || entry.toolCall.status === "failed";
}

/** Shell command text from Pi (`command`) or agy (`CommandLine`) rawInput, falling back to the ACP title. */
function executeCommand(call: AcpToolActivity["toolCall"]): string {
	const input = record(call.rawInput);
	return displayText(String(input.command ?? input.CommandLine ?? input.command_line ?? call.title ?? call.toolCallId));
}

const ACTIVITY_LABELS = {
	read: { done: "Read", running: "Reading", one: "file", many: "files" },
	execute: { done: "Ran", running: "Running", one: "shell command", many: "shell commands" },
} as const;

/**
 * `Read 2 files, ran 1 shell command` in dim text with bold counts, a quiet status line in the assistant
 * text column. Kinds still running use the progressive verb, ending in `...`.
 */
function formatActivityHeader(entries: ToolActivityEntry[], theme: Theme): string {
	const counts = new Map<"read" | "execute", { total: number; running: boolean }>();
	for (const entry of entries) {
		const kind = entry.toolCall.kind === "execute" ? "execute" : "read";
		const count = counts.get(kind) ?? { total: 0, running: false };
		count.total += 1;
		if (!isFinished(entry)) count.running = true;
		counts.set(kind, count);
	}
	const parts = [...counts].map(([kind, { total, running }], index) => {
		const labels = ACTIVITY_LABELS[kind];
		const verb = running ? labels.running : labels.done;
		const shownVerb = index === 0 ? verb : verb.toLowerCase();
		const noun = total === 1 ? labels.one : labels.many;
		return `${theme.fg("dim", `${shownVerb} `)}${theme.fg("dim", theme.bold(String(total)))}${theme.fg("dim", ` ${noun}`)}`;
	});
	const suffix = entries.some((entry) => !isFinished(entry)) ? theme.fg("dim", "...") : "";
	return `${parts.join(theme.fg("dim", ", "))}${suffix}`;
}

const SHELL_COMMAND_MAX_WIDTH = 100;
/** Shortest command duration shown on a grouped shell line; shorter ones would read "(0.0s)". */
const MIN_SHOWN_DURATION_MS = 100;
/** Output lines shown under a grouped shell command while it runs or until its preview collapses. */
const SHELL_PREVIEW_LINES = 4;

/** One `└─ $ command` line plus a short output tail or, when expanded, the full native shell result. */
function renderShellEntry(row: ToolRow, expanded: boolean, theme: Theme, width: number): string[] {
	const entry = row.latest;
	const call = entry.toolCall;
	const isPartial = !isFinished(entry);
	const isError = call.status === "failed";
	const command = executeCommand(call).split("\n");
	const shown = truncateToWidth(`$ ${command.length > 1 ? `${command[0]} …` : command[0]}`, SHELL_COMMAND_MAX_WIDTH, "…");
	// Keep leading spaces (column output such as `wc -l`); drop only surrounding blank lines.
	const output = displayText(toolOutput(entry).replace(/\t/gu, "   ")).replace(/^\n+/u, "").trimEnd();
	let entryLine = theme.fg("muted", shown);
	if (isError) {
		const exitCode = /exit(?:ed with)?(?: status| code)?[:\s]+(\d+)/iu.exec(output)?.[1];
		entryLine += ` ${theme.fg("error", exitCode !== undefined ? `exit ${exitCode}` : "failed")}`;
	}
	// ACP can report start and finish together, so a sub-100ms duration measures notifications, not the command.
	if (!isPartial && entry.durationMs !== undefined && entry.durationMs >= MIN_SHOWN_DURATION_MS) {
		entryLine += ` ${theme.fg("dim", `(${formatDuration(entry.durationMs)})`)}`;
	} else if (isPartial && entry.observedAt !== undefined) {
		entryLine += ` ${theme.fg("dim", `(${formatDuration(Date.now() - entry.observedAt)})`)}`;
	}
	const lines = gutter(new Text(entryLine, 0, 0), 5, `  ${theme.fg("dim", "└─")}`, width);
	if (!output) return lines;
	if (expanded) {
		// The duration is already on the `└─` line; the full output follows it as plain text.
		const color = isError ? "error" : "toolOutput";
		const body = output.split("\n").map((line) => theme.fg(color, line)).join("\n");
		lines.push(...gutter(new Text(body, 0, 0), 5, "     ", width));
	} else if (isPartial || !row.previewCollapsed) {
		const tail = output.split("\n").filter((line) => line.trim().length > 0).slice(-SHELL_PREVIEW_LINES);
		if (tail.length > 0) {
			const color = isError ? "error" : "dim";
			lines.push(...gutter(new Text(tail.map((line) => theme.fg(color, line)).join("\n"), 0, 0), 5, "     ", width));
		}
	}
	return lines;
}

function renderActivityGroup(
	rows: ToolRow[],
	renderers: { read: ToolRenderers },
	cwd: string,
	expanded: boolean,
	keyHints: KeybindingHints,
	theme: Theme,
	width: number,
): string[] {
	if (rows.length === 0) return [];
	const entries = rows.map((row) => row.latest);
	// No status bullet: the header starts in the assistant text column; failures show on their `└─` line.
	const lines = gutter(new Text(formatActivityHeader(entries, theme), 0, 0), 2, "", width);

	for (const row of rows) {
		const entry = row.latest;
		// During the turn every call is listed; once previews collapse at turn end, successful calls fold
		// away so a finished group is just its header. Failed calls stay listed.
		if (row.previewCollapsed && !expanded && entry.toolCall.status === "completed") continue;
		if (entry.toolCall.kind === "execute") {
			lines.push(...renderShellEntry(row, expanded, theme, width));
			continue;
		}
		const readRenderer = renderers.read;
		const previewCollapsed = row.previewCollapsed;
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
	// Shell commands never reach this function: they always render in an activity group.
	if (call.kind === "read" && typeof filePath === "string") {
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
	const webSearch = !renderer ? extractWebSearchArgs(call, input) : undefined;
	const header = renderer?.renderCall?.(args, theme, context) ??
		(webSearch
			? createWebSearchHeaderComponent(webSearch, theme, expanded)
			: new Text(formatGenericToolCall(displayText(call.title ?? call.toolCallId), call.rawInput, theme, expanded), 0, 0));
	const statusColor = isError ? "error" : isPartial ? "border" : "success";
	const lines = gutter(header, 2, theme.fg(statusColor, "⏺"), width);
	const showTiming = !renderer;
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
const WEB_SEARCH_HEADER_LINES = 2;

interface WebSearchArgs {
	query: string;
	domain?: string;
}

function extractWebSearchArgs(call: AcpToolActivity["toolCall"], input: Record<string, unknown>): WebSearchArgs | undefined {
	const name = (call as { name?: unknown }).name;
	const rawTitle = typeof call.title === "string" ? call.title.trim() : "";
	const isOnWebTitle = /^".*" on Web$/su.test(rawTitle);
	const isNamedSearchWeb = name === "search_web" || /\bsearch_web\b/u.test(rawTitle);
	const hasQuery = typeof input.query === "string";
	if (call.kind !== "search" && !isNamedSearchWeb && !isOnWebTitle) return undefined;
	if (!hasQuery && !isNamedSearchWeb && !isOnWebTitle) return undefined;

	let query = hasQuery ? displayText(input.query as string).replace(/\s+/gu, " ").trim() : "";
	if (!query && isOnWebTitle) {
		const quoted = rawTitle.slice(0, -" on Web".length);
		try {
			const parsed = JSON.parse(quoted);
			if (typeof parsed === "string") {
				query = displayText(parsed).replace(/\s+/gu, " ").trim();
			}
		} catch {
			query = displayText(quoted.slice(1, -1)).replace(/\s+/gu, " ").trim();
		}
	}
	const rawDomain = typeof input.domain === "string" ? displayText(input.domain).trim() : "";
	return {
		query,
		...(rawDomain ? { domain: rawDomain } : {}),
	};
}

function createWebSearchHeaderComponent(search: WebSearchArgs, theme: Theme, expanded: boolean): Component {
	const queryText = search.query || "...";
	const header = theme.fg("toolTitle", theme.bold(`WebSearch(${queryText})`));
	const domainSuffix = search.domain ? theme.fg("muted", ` in ${search.domain}`) : "";
	const combined = `${header}${domainSuffix}`;
	return {
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const allLines = new Text(combined, 0, 0).render(width).map((line) => line.trimEnd());
			if (expanded || allLines.length <= WEB_SEARCH_HEADER_LINES) {
				return allLines;
			}
			const marker = theme.fg("toolTitle", theme.bold("…)"));
			if (!domainSuffix) {
				const truncated = allLines.slice(0, WEB_SEARCH_HEADER_LINES);
				const lastIdx = truncated.length - 1;
				const maxBeforeMarker = Math.max(0, width - visibleWidth(marker));
				if (maxBeforeMarker > 0) {
					const last = truncated[lastIdx]!;
					const clipped = visibleWidth(last) > maxBeforeMarker
						? truncateToWidth(last, maxBeforeMarker, "", false)
						: last;
					truncated[lastIdx] = `${clipped}${marker}`;
				} else {
					truncated[lastIdx] = truncateToWidth(marker, width, "");
				}
				return truncated;
			}
			const headerLines = new Text(header, 0, 0).render(width).map((line) => line.trimEnd());
			const tail = `${marker}${domainSuffix}`;
			const maxBeforeTail = width - visibleWidth(tail);
			if (headerLines.length >= WEB_SEARCH_HEADER_LINES && maxBeforeTail > 0) {
				const truncated = headerLines.slice(0, WEB_SEARCH_HEADER_LINES);
				const lastIdx = truncated.length - 1;
				const last = truncated[lastIdx]!;
				const clipped = visibleWidth(last) > maxBeforeTail
					? truncateToWidth(last, maxBeforeTail, "", false)
					: last;
				truncated[lastIdx] = `${clipped}${tail}`;
				return truncated;
			}
			const truncated = allLines.slice(0, WEB_SEARCH_HEADER_LINES);
			const lastIdx = truncated.length - 1;
			truncated[lastIdx] = truncateToWidth(truncated[lastIdx]!, width, "…");
			return truncated;
		},
	};
}

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
	// agy's run_command returns CRLF output; a stray \r renders as an extra blank terminal row.
	const joined = rawToolText(activity).replace(/\r\n?/gu, "\n");
	return activity.toolCall.kind === "execute" ? cleanExecuteOutput(joined) : joined;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function displayText(value: string): string {
	return stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
