import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { AcpToolActivity } from "./events.js";
import { resolveAcpProfileDir } from "./history-cleanup.js";

export interface NativeReadResult {
	stepIndex: number;
	toolCallId: string;
	input: Record<string, unknown>;
	startedAt: number;
	completedAt: number;
	status: "completed" | "failed";
	output: string;
}

const MAX_STEP_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;

/** Optional, display-only evidence. Never executes a tool or writes the upstream database. */
export async function readNativeReadResults(sessionId: string): Promise<NativeReadResult[]> {
	// ACP session IDs are UUIDs, not paths supplied by a model.
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(sessionId)) return [];
	let db: DatabaseSync | undefined;
	try {
		// Older Node versions can still run the provider without this optional repair.
		const { DatabaseSync: Database } = await import("node:sqlite");
		db = new Database(path.join(resolveAcpProfileDir(), "conversations", `${sessionId}.db`), { readOnly: true });
		const results: NativeReadResult[] = [];
		let bytes = 0;
		// The current managed server persists AGENCY_TOOL_CALL=103, DONE=3,
		// binary protobuf step_format=0. Unknown schemas fail closed below.
		const rows = db.prepare(`SELECT idx, step_payload FROM steps
			WHERE step_type = 103 AND status = 3 AND step_format = 0
			AND length(step_payload) <= ${MAX_STEP_BYTES} ORDER BY idx DESC LIMIT 4096`).iterate();
		for (const row of rows) {
			if (!(row.step_payload instanceof Uint8Array) || typeof row.idx !== "number") continue;
			bytes += row.step_payload.byteLength;
			if (bytes > MAX_SCAN_BYTES) break;
			const result = decodeNativeReadResult(row.step_payload, row.idx);
			if (result) results.push(result);
		}
		return results;
	} catch {
		// Missing/locked/corrupt stores or incompatible upstream layouts are not
		// evidence of success or failure. The original ACP record stays intact.
		return [];
	} finally {
		db?.close();
	}
}

/** Exact ID + path + range, with timestamps preventing stale results after ID reuse. */
export function matchNativeReadResult(
	results: NativeReadResult[],
	call: AcpToolActivity["toolCall"],
	observedAt: number,
): NativeReadResult | undefined {
	if (!Number.isFinite(observedAt)) return undefined;
	const input = readInput(call.rawInput);
	if (!input) return undefined;
	const matches = results.filter((result) => result.toolCallId === call.toolCallId &&
		JSON.stringify(readInput(result.input)) === JSON.stringify(input) &&
		// Notifications may arrive shortly after the server timestamps a step.
		result.startedAt <= observedAt + 1000 && result.completedAt >= observedAt - 1000);
	return matches.length === 1 ? matches[0] : undefined;
}

/** Decode only the known native ToolCall/ToolResponse envelope, never infer from DONE alone. */
export function decodeNativeReadResult(payload: Uint8Array, stepIndex: number): NativeReadResult | undefined {
	try {
		if (payload.byteLength > MAX_STEP_BYTES) return undefined;
		const step = protobuf(payload);
		if (single(step, 1) !== 103n || single(step, 4) !== 3n) return undefined;
		const metadata = protobuf(bytes(step, 5));
		const agency = protobuf(bytes(step, 116));
		if (string(agency, 2) !== "view_file") return undefined;
		const callEnvelope = protobuf(bytes(agency, 3));
		const responseEnvelope = protobuf(bytes(agency, 4));
		if (string(callEnvelope, 1) !== "type.googleapis.com/antigravity.localharness.ToolCall" ||
			string(responseEnvelope, 1) !== "type.googleapis.com/antigravity.localharness.ToolResponse") return undefined;
		const call = protobuf(bytes(callEnvelope, 2));
		const response = protobuf(bytes(responseEnvelope, 2));
		const toolCallId = string(call, 1);
		if (!toolCallId || string(call, 2) !== "view_file" || string(response, 1) !== "view_file") return undefined;
		const input = JSON.parse(string(call, 3)) as unknown;
		if (!isRecord(input) || !readInput(input)) return undefined;
		const startedAt = timestamp(bytes(metadata, 6));
		const completedAt = timestamp(bytes(metadata, 8));
		if (completedAt < startedAt) return undefined;
		const error = optionalString(response, 5);
		let output: string;
		let status: NativeReadResult["status"];
		if (error) {
			status = "failed";
			output = error;
		} else {
			const json = JSON.parse(string(response, 2)) as unknown;
			if (!isRecord(json)) return undefined;
			if (typeof json.error === "string" && json.error) {
				status = "failed";
				output = json.error;
			} else if (typeof json.result === "string") {
				status = "completed";
				output = json.result;
			} else return undefined;
		}
		if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + "\n[Native read preview truncated; full response remains in Antigravity.]";
		return { stepIndex, toolCallId, input, startedAt, completedAt, status, output };
	} catch {
		return undefined;
	}
}

function readInput(value: unknown): readonly [string, number, number | null] | undefined {
	if (!isRecord(value)) return undefined;
	const file = value.AbsolutePath ?? value.absolute_path;
	const start = value.StartLine ?? value.start_line ?? 1;
	const end = value.EndLine ?? value.end_line;
	if (typeof file !== "string" || !path.isAbsolute(file) ||
		typeof start !== "number" || !Number.isSafeInteger(start) || start < 1 ||
		(end !== undefined && (typeof end !== "number" || !Number.isSafeInteger(end) || end < start))) return undefined;
	return [path.normalize(file), start, end ?? null];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

// Minimal bounded protobuf wire reader. Reject duplicate singular fields,
// unsupported wires and malformed lengths rather than guessing a new schema.
type Fields = Map<number, (bigint | Uint8Array)[]>;
function protobuf(data: Uint8Array): Fields {
	let position = 0;
	const fields: Fields = new Map();
	const varint = (): bigint => {
		let value = 0n;
		for (let shift = 0n; shift < 70n; shift += 7n) {
			const byte = data[position++];
			if (byte === undefined) throw new Error("Truncated protobuf varint");
			value |= BigInt(byte & 127) << shift;
			if (byte < 128) return value;
		}
		throw new Error("Invalid protobuf varint");
	};
	let count = 0;
	while (position < data.length) {
		if (++count > 4096) throw new Error("Too many protobuf fields");
		const tag = varint();
		const field = Number(tag >> 3n);
		const wire = Number(tag & 7n);
		if (field <= 0 || field > 536870911) throw new Error("Invalid protobuf field");
		let value: bigint | Uint8Array;
		if (wire === 0) value = varint();
		else {
			const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
			if (!Number.isSafeInteger(length) || length < 0 || length > data.length - position) throw new Error("Invalid protobuf length");
			value = data.subarray(position, position + length);
			position += length;
			if (wire !== 2) continue;
		}
		const values = fields.get(field) ?? [];
		values.push(value);
		fields.set(field, values);
	}
	return fields;
}

function single(fields: Fields, field: number): bigint | Uint8Array | undefined {
	const values = fields.get(field);
	if (values && values.length !== 1) throw new Error("Duplicate protobuf field");
	return values?.[0];
}

function bytes(fields: Fields, field: number): Uint8Array {
	const value = single(fields, field);
	if (!(value instanceof Uint8Array)) throw new Error("Missing protobuf message");
	return value;
}

function string(fields: Fields, field: number): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes(fields, field));
}

function optionalString(fields: Fields, field: number): string | undefined {
	return single(fields, field) === undefined ? undefined : string(fields, field);
}

function timestamp(data: Uint8Array): number {
	const fields = protobuf(data);
	const seconds = single(fields, 1);
	const nanos = single(fields, 2) ?? 0n;
	if (typeof seconds !== "bigint" || seconds <= 0 || typeof nanos !== "bigint" || nanos < 0 || nanos >= 1_000_000_000n) throw new Error("Invalid protobuf timestamp");
	const value = Number(seconds) * 1000 + Number(nanos) / 1_000_000;
	if (!Number.isSafeInteger(Number(seconds)) || !Number.isFinite(value)) throw new Error("Invalid protobuf timestamp");
	return value;
}
