import fs from "node:fs/promises";
import path from "node:path";

import { resolveAcpProfileDir } from "./history-cleanup.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
/** The server can report a step's usage just before writing the step out. */
const RETRY_DELAYS_MS = [50, 100, 200, 400];
/** The harness checkpoints on its own count, about one token per 2.7-3.1
 * UTF-8 bytes of transcript whatever the content (measured 2026-10-17, server
 * 1.4.0: a coding session 2.68, hex logs 2.89, English docs 2.91, TypeScript
 * 3.00, Chinese 3.06). The lower divisor overestimates it slightly so Pi
 * compacts first. */
export const HARNESS_BYTES_PER_TOKEN = 2.6;
const RECENT_STEPS = 16;
const TRUNCATION_NOTE = /<truncated (\d+) bytes>/u;

interface StepTokens {
	input: number;
	cacheRead: number;
	output: number;
}

interface TranscriptScan {
	offset: number;
	/** Every byte of the session. After the harness's own checkpoint it holds
	 * less, but Pi's context does not: the count stays high so Pi compacts. */
	bytes: number;
	checkpoints: number;
	recent: StepTokens[];
}

const scans = new Map<string, TranscriptScan>();

/** Context fill as Antigravity limits it: the larger of the real prompt size
 * and the harness's own count. `usage_update.used` counts cached tokens twice
 * (input + 2 × cacheRead + output, verified 2026-10-17, server 1.4.0); the
 * transcript step that produced it gives the real size. An unexplained value
 * stays as reported, which at worst makes Pi compact early, never late. */
export async function contextTokensInUse(
	sessionId: string,
	used: number,
	profile = resolveAcpProfileDir(),
	retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<number> {
	if (!UUID.test(sessionId)) return used;
	const file = transcriptFile(sessionId, profile);
	for (const delay of [0, ...retryDelaysMs]) {
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		let scan: TranscriptScan;
		try {
			scan = await advance(file);
		} catch {
			return used;
		}
		for (let index = scan.recent.length - 1; index >= 0; index--) {
			const step = scan.recent[index]!;
			if (step.input + 2 * step.cacheRead + step.output !== used) continue;
			return Math.max(step.input + step.cacheRead + step.output, Math.ceil(scan.bytes / HARNESS_BYTES_PER_TOKEN));
		}
	}
	return used;
}

/** How many times the harness replaced this session's history with its own
 * summary, as of the last contextTokensInUse call. */
export function transcriptCheckpoints(sessionId: string, profile = resolveAcpProfileDir()): number {
	return scans.get(transcriptFile(sessionId, profile))?.checkpoints ?? 0;
}

function transcriptFile(sessionId: string, profile: string): string {
	return path.join(profile, "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl");
}

/** Reads only what was appended since the last call; a partial last line waits. */
async function advance(file: string): Promise<TranscriptScan> {
	const handle = await fs.open(file, "r");
	try {
		const { size } = await handle.stat();
		let scan = scans.get(file);
		if (!scan || size < scan.offset) {
			scan = { offset: 0, bytes: 0, checkpoints: 0, recent: [] };
			scans.set(file, scan);
		}
		if (size === scan.offset) return scan;
		const buffer = Buffer.alloc(size - scan.offset);
		await handle.read(buffer, 0, buffer.length, scan.offset);
		const end = buffer.lastIndexOf(0x0a);
		if (end < 0) return scan;
		scan.offset += end + 1;
		for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) record(scan, line);
		return scan;
	} finally {
		await handle.close();
	}
}

function record(scan: TranscriptScan, line: string): void {
	let step: unknown;
	try {
		step = JSON.parse(line);
	} catch {
		return;
	}
	if (!step || typeof step !== "object") return;
	const fields = step as Record<string, unknown>;
	if (fields.type === "CHECKPOINT") scan.checkpoints += 1;
	if (fields.content !== undefined) {
		const text = typeof fields.content === "string" ? fields.content : JSON.stringify(fields.content);
		// The transcript keeps about 49 KB of a tool result and 192 KB of a user
		// input (such as a rebuilt session's history), noting what it dropped.
		const dropped = TRUNCATION_NOTE.exec(text);
		scan.bytes += Buffer.byteLength(text, "utf8") + (dropped ? Number(dropped[1]) : 0);
	}
	if (fields.tool_calls !== undefined) scan.bytes += Buffer.byteLength(JSON.stringify(fields.tool_calls), "utf8");
	if (fields.type !== "PLANNER_RESPONSE") return;
	const input = count(fields.input_tokens);
	const cacheRead = count(fields.cache_read_tokens ?? 0);
	const output = count(fields.output_tokens ?? 0);
	if (input === undefined || cacheRead === undefined || output === undefined) return;
	scan.recent.push({ input, cacheRead, output });
	if (scan.recent.length > RECENT_STEPS) scan.recent.shift();
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
