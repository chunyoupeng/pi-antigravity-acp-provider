import {
	type BashOperations,
	type BashToolOptions,
	createBashToolDefinition,
	createLocalBashOperations,
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	formatSize,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_TEXT_RESULT_BYTES } from "../src/models.js";

export { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_TEXT_RESULT_BYTES } from "../src/models.js";

/** Default period of complete stdout/stderr silence before an untimed command
 * detaches to the background instead of hanging the MCP turn. Kept below
 * TOOL_HANDOFF_MS (150s) so a hung SSH/daemon pipe returns within the turn. */
export const DEFAULT_BASH_IDLE_DETACH_MS = 120_000;

export interface SafeBashToolOptions extends BashToolOptions {
	/** Idle stdout/stderr window in ms before an untimed command detaches to the background (default: 120_000). */
	idleDetachMs?: number;
}

/** Room left for the continuation note, so the whole result stays within MAX_TEXT_RESULT_BYTES. */
const BODY_BYTES = MAX_TEXT_RESULT_BYTES - 1024;
const BODY_LIMIT = formatSize(BODY_BYTES);
const BASH_STATUS =
	/\n\n(Command (?:exited with code -?\d+|timed out after \d+ seconds|terminated without an exit code|aborted)|\[Command produced no new output for [\d.]+s and was detached to background[^\n]*\])$/u;
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
 * as Pi keeps the tail, and names a file holding the complete output. Untimed
 * commands that produce no new output for `idleDetachMs` (default 120s) detach
 * to the background without killing the process, so active downloads/builds keep
 * running while hung SSH/daemon pipes return their collected output.
 */
export function createSafeBashToolDefinition(cwd: string, options?: SafeBashToolOptions) {
	const original = createBashToolDefinition(cwd, options);
	const baseOps =
		options?.operations ??
		createLocalBashOperations(options?.shellPath === undefined ? undefined : { shellPath: options.shellPath });
	const idleDetachMs = options?.idleDetachMs ?? DEFAULT_BASH_IDLE_DETACH_MS;
	return {
		...original,
		execute: async (...args: Parameters<typeof original.execute>) => {
			const signal = args[2];
			if (args[4].model?.provider !== "antigravity-acp") return original.execute(...args);
			let detachedNote: string | undefined;
			const safeTool = createBashToolDefinition(cwd, {
				...options,
				operations: {
					exec: async (command, execCwd, execOptions) => {
						if (execOptions.timeout !== undefined || idleDetachMs <= 0) {
							return baseOps.exec(command, execCwd, execOptions);
						}
						return runWithIdleDetach(baseOps, command, execCwd, execOptions, idleDetachMs, (note) => {
							detachedNote = note;
						});
					},
				},
			});
			let result: Awaited<ReturnType<typeof original.execute>>;
			try {
				result = await safeTool.execute(...args);
			} catch (error) {
				if (signal?.aborted || !(error instanceof Error) || Buffer.byteLength(error.message, "utf8") <= MAX_TEXT_RESULT_BYTES) {
					throw error;
				}
				throw new Error(await tailText(error.message, signal));
			}
			const block = result.content[0];
			if (block?.type !== "text") return result;
			const rawText = detachedNote ? `${block.text}\n\n${detachedNote}` : block.text;
			if (Buffer.byteLength(rawText, "utf8") <= MAX_TEXT_RESULT_BYTES) {
				return detachedNote ? { ...result, content: [{ type: "text" as const, text: rawText }] } : result;
			}
			return { ...result, content: [{ type: "text" as const, text: await tailText(rawText, signal) }] };
		},
	};
}

function runWithIdleDetach(
	baseOps: BashOperations,
	command: string,
	execCwd: string,
	execOptions: Parameters<BashOperations["exec"]>[2],
	idleDetachMs: number,
	onDetached: (note: string) => void,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let detached = false;
		let idleTimer: NodeJS.Timeout | undefined;
		let detachedLogPath: string | undefined;
		let writeChain = Promise.resolve();
		const preDetachChunks: Buffer[] = [];
		let preDetachBytes = 0;

		const childAbort = new AbortController();
		const onCallerAbort = () => {
			if (!detached) childAbort.abort();
		};
		if (execOptions.signal?.aborted) {
			childAbort.abort();
		} else {
			execOptions.signal?.addEventListener("abort", onCallerAbort, { once: true });
		}

		const cleanup = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			execOptions.signal?.removeEventListener("abort", onCallerAbort);
		};

		const armIdleTimer = () => {
			if (settled || detached) return;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				if (settled || detached) return;
				detached = true;
				settled = true;
				cleanup();
				detachedLogPath = path.join(os.tmpdir(), `pi-bash-detached-${randomUUID()}.log`);
				const logPath = detachedLogPath;
				const initial = Buffer.concat(preDetachChunks);
				preDetachChunks.length = 0;
				writeChain = writeFile(logPath, initial).catch(() => {});
				const secs = Math.round((idleDetachMs / 1000) * 10) / 10;
				onDetached(
					`[Command produced no new output for ${secs}s and was detached to background (not killed). Ongoing output: ${logPath}]`,
				);
				void writeChain.then(() => resolve({ exitCode: 0 }));
			}, idleDetachMs);
			idleTimer.unref?.();
		};

		armIdleTimer();

		baseOps
			.exec(command, execCwd, {
				...execOptions,
				signal: childAbort.signal,
				onData: (chunk) => {
					if (!detached) {
						preDetachChunks.push(chunk);
						preDetachBytes += chunk.byteLength;
						while (preDetachBytes > MAX_TEXT_RESULT_BYTES && preDetachChunks.length > 1) {
							preDetachBytes -= preDetachChunks.shift()!.byteLength;
						}
						armIdleTimer();
						execOptions.onData(chunk);
					} else if (detachedLogPath) {
						const logPath = detachedLogPath;
						writeChain = writeChain.then(() => appendFile(logPath, chunk)).catch(() => {});
					}
				},
			})
			.then(
				(result) => {
					if (settled) return;
					settled = true;
					cleanup();
					preDetachChunks.length = 0;
					resolve(result);
				},
				(error) => {
					if (settled) return;
					settled = true;
					cleanup();
					preDetachChunks.length = 0;
					reject(error);
				},
			);
	});
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
