import {
	type BashToolOptions,
	createBashToolDefinition,
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	formatSize,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_TEXT_RESULT_BYTES } from "../src/models.js";

export { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_TEXT_RESULT_BYTES } from "../src/models.js";

/** Room left for the continuation note, so the whole result stays within MAX_TEXT_RESULT_BYTES. */
const BODY_BYTES = MAX_TEXT_RESULT_BYTES - 1024;
const BODY_LIMIT = formatSize(BODY_BYTES);
const BASH_STATUS = /\n\n(Command (?:exited with code -?\d+|timed out after \d+ seconds|terminated without an exit code|aborted))$/u;
const BASH_NOTE = /\n\n\[Showing (?:lines \d+-\d+ of (\d+)|last .+? of line (\d+))[^\n]*?Full output: ([^\n]+)\]$/u;

/**
 * Pi's read for Antigravity. Images are clamped to 512 KiB and 1536px, and
 * text pages at 45 KiB instead of Pi's 50 KiB: the harness cuts text results
 * over 48 KiB, which would drop Pi's "Use offset=N to continue" note.
 */
export function createSafeReadToolDefinition(cwd: string) {
	const original = createReadToolDefinition(cwd);
	return {
		...original,
		execute: async (...args: Parameters<typeof original.execute>) => {
			const [id, params, signal, onUpdate, ctx] = args;
			if (ctx.model?.provider !== "antigravity-acp") return original.execute(...args);

			// Capture the bytes from the original reader, not a second file read.
			let file: Buffer | undefined;
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
						file = await readFile(path, { signal });
						return file;
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
			const block = result.content[0];
			if (!file || image || block?.type !== "text" || Buffer.byteLength(block.text, "utf8") <= MAX_TEXT_RESULT_BYTES) {
				return result;
			}
			const page = pageText(file.toString("utf8"), params.path, params.offset, params.limit);
			return {
				...result,
				content: [{ type: "text" as const, text: page.text }],
				details: { truncation: page.truncation },
				...(typeof result.structuredContent === "string" ? { structuredContent: page.text } : {}),
			};
		},
	};
}

/** Pi's read pagination with a 45 KiB page. */
function pageText(content: string, filePath: string, offset?: number, limit?: number) {
	const lines = content.split("\n");
	const start = offset ? Math.max(0, offset - 1) : 0;
	const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
	const truncation = truncateHead(lines.slice(start, end).join("\n"), { maxBytes: BODY_BYTES });
	if (truncation.firstLineExceedsLimit) {
		const size = formatSize(Buffer.byteLength(lines[start] ?? "", "utf8"));
		return {
			text: `[Line ${start + 1} is ${size}, exceeds ${BODY_LIMIT} limit. Use pi_bash: sed -n '${start + 1}p' ${filePath} | head -c ${BODY_BYTES}]`,
			truncation,
		};
	}
	const shownEnd = start + truncation.outputLines;
	if (truncation.truncated) {
		const limitNote = truncation.truncatedBy === "lines" ? "" : ` (${BODY_LIMIT} limit)`;
		return {
			text: `${truncation.content}\n\n[Showing lines ${start + 1}-${shownEnd} of ${lines.length}${limitNote}. Use offset=${shownEnd + 1} to continue.]`,
			truncation,
		};
	}
	if (end < lines.length) {
		return {
			text: `${truncation.content}\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`,
			truncation,
		};
	}
	return { text: truncation.content, truncation };
}

/**
 * Pi's bash for Antigravity. Output over 45 KiB keeps its last 45 KiB inline,
 * as Pi keeps the tail, and names a file holding the complete output.
 */
export function createSafeBashToolDefinition(cwd: string, options?: BashToolOptions) {
	const original = createBashToolDefinition(cwd, options);
	return {
		...original,
		execute: async (...args: Parameters<typeof original.execute>) => {
			const signal = args[2];
			if (args[4].model?.provider !== "antigravity-acp") return original.execute(...args);
			let result: Awaited<ReturnType<typeof original.execute>>;
			try {
				result = await original.execute(...args);
			} catch (error) {
				if (signal?.aborted || !(error instanceof Error) || Buffer.byteLength(error.message, "utf8") <= MAX_TEXT_RESULT_BYTES) {
					throw error;
				}
				throw new Error(await tailText(error.message, signal));
			}
			const block = result.content[0];
			if (block?.type !== "text" || Buffer.byteLength(block.text, "utf8") <= MAX_TEXT_RESULT_BYTES) return result;
			return { ...result, content: [{ type: "text" as const, text: await tailText(block.text, signal) }] };
		},
	};
}

/** Re-truncates Pi's bash text to a 45 KiB tail, keeping its exit status. Pi
 * already saved the complete output when it truncated; otherwise it is saved here. */
async function tailText(text: string, signal?: AbortSignal): Promise<string> {
	const status = BASH_STATUS.exec(text);
	let output = status ? text.slice(0, status.index) : text;
	const note = BASH_NOTE.exec(output);
	let fullOutputPath = note?.[3];
	if (note) output = output.slice(0, note.index);
	if (!fullOutputPath) {
		fullOutputPath = path.join(os.tmpdir(), `pi-bash-${randomUUID()}.log`);
		await writeFile(fullOutputPath, output, { signal });
	}
	const tail = truncateTail(output, { maxBytes: BODY_BYTES });
	const endLine = Number(note?.[1] ?? note?.[2] ?? tail.totalLines);
	const shown = tail.lastLinePartial
		? `[Showing last ${formatSize(tail.outputBytes)} of line ${endLine}. Full output: ${fullOutputPath}]`
		: `[Showing lines ${endLine - tail.outputLines + 1}-${endLine} of ${endLine} (${BODY_LIMIT} limit). Full output: ${fullOutputPath}]`;
	return `${tail.content}\n\n${shown}${status ? `\n\n${status[1]}` : ""}`;
}
