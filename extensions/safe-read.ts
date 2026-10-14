import {
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveAntigravityAcpDirectory } from "../src/acp/antigravity.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from "../src/models.js";

export { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from "../src/models.js";

const INLINE_BYTES = 4 * 1024;
const PREVIEW_BYTES = 3 * 1024;
const MAX_PARALLEL_OFFSETS = 24;
/** Folder under App Data Directory (`~/.gemini/antigravity-acp`, the only
 * directory outside the workspace that passes both view_file gates) holding
 * copies of non-Chinese files that view_file cannot open in place. */
export const STAGE_DIRECTORY_NAME = "pi-read-cache";
const STAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Share of non-whitespace characters that must be Han for a file to count as
 * Chinese. Calibrated 2026-10-14: a Chinese requirements doc scores ~14%,
 * while Java sources with ordinary Chinese comments stay at 1-7%. */
export const CHINESE_RATIO_THRESHOLD = 0.1;
const HAN_GLOBAL = /\p{Script=Han}/gu;
const NON_WHITESPACE_GLOBAL = /\S/gu;

/**
 * Hybrid Antigravity reader. `pi_read` is the first read for every text file.
 * Files <= 4 KiB return inline unchanged. Larger files return a summary (size,
 * line count, Chinese share, what to do next), a raw preview of up to 3 KiB
 * (often enough on its own), and a footer with the exact continuation:
 * - Chinese files (>= 10% Han characters): exact page offsets so the model can
 *   call `pi_read` in parallel in a single turn (avoiding `view_file`'s
 *   `\uXXXX` escaping).
 * - Non-Chinese files inside the `view_file` whitelist (session cwd / App Data
 *   Directory): one `view_file` call on the file for the lines not shown.
 * - Non-Chinese files elsewhere: the whole file is copied into
 *   `<App Data Directory>/pi-read-cache/` and `view_file` reads the copy.
 */
export function createSafeReadToolDefinition(cwd: string, appDataDirectory = resolveAntigravityAcpDirectory()) {
	const original = createReadToolDefinition(cwd);
	return {
		...original,
		execute: async (...args: Parameters<typeof original.execute>) => {
			const [id, params, signal, onUpdate, ctx] = args;
			if (ctx.model?.provider !== "antigravity-acp") return original.execute(...args);

			// Capture the bytes from the original reader, not a second file read.
			let file: { path: string; buffer: Buffer } | undefined;
			let image = false;
			const modelResize = ctx.model?.inputLimits?.images?.resize;
			const resizeOptions = {
				...modelResize,
				maxWidth: Math.min(modelResize?.maxWidth ?? MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION),
				maxHeight: Math.min(modelResize?.maxHeight ?? MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION),
				maxBytes: Math.min(modelResize?.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
			};
			const reader = createReadToolDefinition(cwd, {
				resizeOptions,
				operations: {
					access: (path) => access(path, constants.R_OK),
					detectImageMimeType: async (path) => {
						const mimeType = await detectSupportedImageMimeTypeFromFile(path);
						image = mimeType !== null;
						return mimeType;
					},
					readFile: async (path) => {
						const buffer = await readFile(path, { signal });
						file = { path, buffer };
						return buffer;
					},
				},
			});
			const readCtx =
				ctx.model &&
				(ctx.model.inputLimits?.images?.resize?.maxBytes !== resizeOptions.maxBytes ||
					ctx.model.inputLimits?.images?.resize?.maxWidth !== resizeOptions.maxWidth ||
					ctx.model.inputLimits?.images?.resize?.maxHeight !== resizeOptions.maxHeight)
					? {
							...ctx,
							model: {
								...ctx.model,
								inputLimits: {
									...ctx.model.inputLimits,
									images: {
										...ctx.model.inputLimits?.images,
										resize: resizeOptions,
									},
								},
							},
						}
					: ctx;
			const result = await reader.execute(id, params, signal, onUpdate, readCtx);
			if (!file || image || typeof result.structuredContent !== "string") return result;
			if (file.buffer.byteLength <= INLINE_BYTES && Buffer.byteLength(result.structuredContent, "utf8") <= INLINE_BYTES) {
				return result;
			}

			const fullText = file.buffer.toString("utf8");
			const lines = fullText.split("\n");
			const ratio = chineseRatio(fullText);
			const header = `[File: ${utf8Prefix(file.path, 512)} | Total: ${lines.length} lines, ${(file.buffer.byteLength / 1024).toFixed(1)} KiB]`;
			let route: Route = { kind: "chinese" };
			if (ratio < CHINESE_RATIO_THRESHOLD) {
				route = { kind: "view", target: file.path };
				if (!isInsideAny(file.path, [ctx.cwd ?? cwd, appDataDirectory])) {
					try {
						route = { kind: "view", target: await stageCopy(appDataDirectory, file, signal), original: file.path };
					} catch (error) {
						if (signal?.aborted) throw error;
						// Staging is an optimization; Pi's own paginated read still works.
						return result;
					}
				}
			}

			const page = renderPage({ header, lines, ratio, route, offset: params.offset, limit: params.limit });
			return {
				...result,
				content: [{ type: "text" as const, text: page.text }],
				details: route.kind === "chinese" ? { truncation: page.truncation } : undefined,
				structuredContent: page.text,
			};
		},
	};
}

/** Han characters as a share of non-whitespace characters (0 for blank text). */
export function chineseRatio(text: string): number {
	const nonWhitespace = text.match(NON_WHITESPACE_GLOBAL)?.length ?? 0;
	if (nonWhitespace === 0) return 0;
	return (text.match(HAN_GLOBAL)?.length ?? 0) / nonWhitespace;
}

/** Pre-computes 1-indexed starting line offsets for subsequent `maxBytes` pages. */
export function nextPageOffsets(
	lines: readonly string[],
	startIndex: number,
	maxBytes: number,
	maxPages = MAX_PARALLEL_OFFSETS,
): number[] {
	const offsets: number[] = [];
	let cursor = startIndex;
	while (cursor < lines.length && offsets.length < maxPages) {
		offsets.push(cursor + 1);
		if (Buffer.byteLength(lines[cursor]!, "utf8") > maxBytes) break;
		let pageBytes = 0;
		let count = 0;
		while (cursor + count < lines.length) {
			const lineBytes = Buffer.byteLength(lines[cursor + count]!, "utf8") + (count > 0 ? 1 : 0);
			if (pageBytes + lineBytes > maxBytes) break;
			pageBytes += lineBytes;
			count++;
		}
		if (count === 0) break;
		cursor += count;
	}
	return offsets;
}

/**
 * Copies a file view_file cannot reach into `<appData>/pi-read-cache/`. The
 * name hashes path and content, so an unchanged file reuses its copy and an
 * edited one gets a fresh copy. Copies unused for 7 days are pruned.
 */
async function stageCopy(appDataDirectory: string, file: { path: string; buffer: Buffer }, signal?: AbortSignal): Promise<string> {
	const directory = path.join(appDataDirectory, STAGE_DIRECTORY_NAME);
	await mkdir(directory, { recursive: true });
	const hash = createHash("sha256").update(file.path).update("\0").update(file.buffer).digest("hex").slice(0, 16);
	const staged = path.join(directory, `${hash}-${utf8Prefix(path.basename(file.path), 160)}`);
	const existing = await stat(staged).catch(() => undefined);
	if (existing?.isFile() && existing.size === file.buffer.byteLength) {
		const now = new Date();
		await utimes(staged, now, now).catch(() => undefined);
	} else {
		// Write then rename, so an interrupted write never leaves a partial copy under the final name.
		const temporary = `${staged}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(temporary, file.buffer, { signal });
			await rename(temporary, staged);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}
	void pruneStaged(directory, staged);
	return staged;
}

async function pruneStaged(directory: string, keep: string): Promise<void> {
	try {
		const cutoff = Date.now() - STAGE_MAX_AGE_MS;
		for (const name of await readdir(directory)) {
			const entry = path.join(directory, name);
			if (entry === keep) continue;
			const info = await stat(entry).catch(() => undefined);
			if (info?.isFile() && info.mtimeMs < cutoff) await rm(entry, { force: true });
		}
	} catch {
		// Best effort only.
	}
}

type Route =
	| { kind: "chinese" }
	/** `target` is opened with view_file; `original` is set when it is a staged copy. */
	| { kind: "view"; target: string; original?: string };

interface PageInput {
	header: string;
	lines: readonly string[];
	ratio: number;
	route: Route;
	offset?: number | undefined;
	limit?: number | undefined;
}

/**
 * Every large read returns: header, a summary of the file and what to do next
 * (on a first read), a raw preview of up to 3 KiB, and a footer with the exact
 * continuation (parallel pi_read offsets, or one view_file call). The preview
 * shrinks when needed so the whole result stays inline (<= 4 KiB).
 */
function renderPage(input: PageInput): { text: string; truncation: ReturnType<typeof truncateHead> } {
	let budget = PREVIEW_BYTES;
	for (;;) {
		const page = renderWithBudget(input, budget);
		const overflow = Buffer.byteLength(page.text, "utf8") - INLINE_BYTES;
		if (overflow <= 0 || budget <= 256) return page;
		budget = Math.max(256, budget - overflow - 16);
	}
}

function renderWithBudget(input: PageInput, budget: number): { text: string; truncation: ReturnType<typeof truncateHead> } {
	const { header, lines, ratio, route, offset, limit } = input;
	const total = lines.length;
	const start = offset ? Math.max(0, offset - 1) : 0;
	const requestedEnd = limit === undefined ? total : Math.min(total, start + limit);
	const selected = lines.slice(start, requestedEnd);
	const truncation = truncateHead(selected.join("\n"), { maxBytes: budget, maxLines: Number.MAX_SAFE_INTEGER });
	const longLine = truncation.firstLineExceedsLimit;
	const shownEnd = longLine ? start : start + (truncation.truncated ? truncation.outputLines : selected.length);
	const body = longLine ? utf8Prefix(selected[0] ?? "", budget) : truncation.content;
	const percent = `${(ratio * 100).toFixed(1)}% Chinese characters`;
	const preview = longLine
		? `Preview: the first ${Buffer.byteLength(body, "utf8")} bytes of line ${start + 1}`
		: `Preview: lines ${start + 1}-${shownEnd}${shownEnd >= total && start === 0 ? " (whole file)" : ""}`;

	let summary: string | undefined;
	let footer: string | undefined;
	if (route.kind === "chinese") {
		// Parallel page reads skip the summary; the model already has it from the first read.
		if (offset === undefined) {
			summary = `[Summary: Chinese text (${percent}). ${preview} below. If the preview is enough, stop here; otherwise call pi_read for every page offset listed at the end, in parallel in one turn.]`;
		}
		if (longLine) {
			// A line offset cannot resume in the middle of a line. Do not claim it can.
			footer = `[Line ${start + 1} exceeds 3 KiB; only its prefix is shown. Use pi_bash to read this line in chunks.]`;
		} else if (shownEnd < total) {
			const offsets = limit === undefined ? nextPageOffsets(lines, shownEnd, PREVIEW_BYTES, MAX_PARALLEL_OFFSETS) : [];
			const parallelHint = offsets.length > 1 ? ` (parallel page offsets: ${offsets.join(", ")})` : "";
			footer = `[${total - shownEnd} lines remaining. If more content is needed, use offset=${shownEnd + 1} to continue${parallelHint}.]`;
		}
	} else {
		const where = route.original === undefined
			? ""
			: ` It is outside Active Workspaces, so view_file cannot open it; pi_read copied the complete file to ${route.target}.`;
		summary = `[Summary: Non-Chinese text (${percent}, below ${CHINESE_RATIO_THRESHOLD * 100}%).${where} ${preview} below. If the preview is enough, stop here; otherwise use view_file as described at the end instead of paging pi_read.]`;
		const copyNote = route.original === undefined
			? ""
			: ` That path is a complete copy of ${route.original}; line numbers match. Edit the original path, not the copy.`;
		const restStart = longLine ? start + 1 : shownEnd + 1;
		if (restStart <= requestedEnd) {
			const endLine = requestedEnd < total ? `, EndLine=${requestedEnd}` : "";
			footer = `[${longLine ? `Line ${restStart} is longer than the preview.` : `Lines ${restStart}-${requestedEnd} are not shown.`} Read them with one view_file call (AbsolutePath: ${route.target}, StartLine=${restStart}${endLine}).${copyNote}]`;
		} else if (requestedEnd < total) {
			footer = `[${total - requestedEnd} more lines in file after line ${requestedEnd}. If needed, read them with view_file (AbsolutePath: ${route.target}, StartLine=${requestedEnd + 1}).${copyNote}]`;
		}
	}
	const text = [header, summary, body].filter((part) => part !== undefined).join("\n") + (footer ? `\n...\n${footer}` : "");
	return { text, truncation };
}

/** True when `target` (after resolving symlinks) lies under any of `roots`. */
function isInsideAny(target: string, roots: readonly string[]): boolean {
	const resolved = realpathOr(path.resolve(target));
	return roots.some((root) => {
		const relative = path.relative(realpathOr(path.resolve(root)), resolved);
		return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	});
}

function realpathOr(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return target;
	}
}

/** Limit bytes without splitting a UTF-8 code point. */
function utf8Prefix(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
