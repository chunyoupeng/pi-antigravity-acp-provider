import {
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

const INLINE_BYTES = 4 * 1024;
const PREVIEW_BYTES = 3 * 1024;

/** Keep Antigravity's read results inline without changing Pi's other readers. */
export function createSafeReadToolDefinition(cwd: string) {
	const original = createReadToolDefinition(cwd);
	return {
		...original,
		execute: async (...args: Parameters<typeof original.execute>) => {
			const [id, params, signal, onUpdate, ctx] = args;
			if (ctx.model?.provider !== "antigravity-acp") return original.execute(...args);

			// Capture the bytes from the original reader, not a second file read.
			let file: { path: string; buffer: Buffer } | undefined;
			let image = false;
			const reader = createReadToolDefinition(cwd, {
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
			const result = await reader.execute(id, params, signal, onUpdate, ctx);
			if (!file || image || typeof result.structuredContent !== "string") return result;
			if (file.buffer.byteLength <= INLINE_BYTES && Buffer.byteLength(result.structuredContent, "utf8") <= INLINE_BYTES) {
				return result;
			}

			const lines = file.buffer.toString("utf8").split("\n");
			const start = params.offset ? Math.max(0, params.offset - 1) : 0;
			const selected = lines.slice(start, params.limit === undefined ? undefined : start + params.limit);
			const truncation = truncateHead(selected.join("\n"), {
				maxBytes: PREVIEW_BYTES,
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			const header = `[File: ${utf8Prefix(file.path, 512)} | Total: ${lines.length} lines, ${(file.buffer.byteLength / 1024).toFixed(1)} KiB]`;
			let text: string;
			if (truncation.firstLineExceedsLimit) {
				// A line offset cannot resume in the middle of a line. Do not claim it can.
				text = `${header}\n${utf8Prefix(selected[0] ?? "", PREVIEW_BYTES)}\n...\n[Line ${start + 1} exceeds 3 KiB; only its prefix is shown. Use pi_bash to read this line in chunks.]`;
			} else {
				const shown = truncation.truncated ? truncation.outputLines : selected.length;
				const next = start + shown;
				text = `${header}\n${truncation.content}`;
				if (next < lines.length) {
					text += `\n...\n[${lines.length - next} lines remaining. If more content is needed, use offset=${next + 1} to continue.]`;
				}
			}
			return {
				...result,
				content: [{ type: "text" as const, text }],
				details: { truncation },
				structuredContent: text,
			};
		},
	};
}

/** Limit bytes without splitting a UTF-8 code point. */
function utf8Prefix(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
