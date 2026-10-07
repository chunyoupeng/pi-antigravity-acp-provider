import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeNativeReadResult, matchNativeReadResult, readNativeReadResults } from "../src/acp/native-read-results.js";
import { field, nativeReadStep } from "./fixtures/native-read-step.js";

const observedAt = Date.parse("2026-01-01T00:00:00Z");
const call = {
	toolCallId: "call", kind: "read" as const, title: "Running view_file",
	rawInput: { AbsolutePath: "/workspace/file.ts", StartLine: 1, EndLine: 10 },
};
const sessionId = "8e24af42-55f0-4651-a986-f45bf67aacaa";
const directories: string[] = [];
const sqlite = await import("node:sqlite").catch(() => undefined);

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("native read evidence", () => {
	it("decodes original tool ID, parameters, timestamps and content", () => {
		expect(decodeNativeReadResult(nativeReadStep(), 453)).toEqual({
			stepIndex: 453, toolCallId: "call", input: call.rawInput,
			startedAt: observedAt, completedAt: observedAt + 100,
			status: "completed", output: "const value = 1;",
		});
	});

	it("reads the explicit response error even when the step is DONE", () => {
		const result = decodeNativeReadResult(nativeReadStep({ error: "[Errno 2] No such file or directory" }), 574);
		expect(result).toMatchObject({ status: "failed", output: "[Errno 2] No such file or directory" });
		expect(decodeNativeReadResult(nativeReadStep({ responseJson: '{"error":"Permission denied"}' }), 575))
			.toMatchObject({ status: "failed", output: "Permission denied" });
	});

	it("allows an empty file and does not mistake file contents for an error", () => {
		expect(decodeNativeReadResult(nativeReadStep({ output: "" }), 1)).toMatchObject({ status: "completed", output: "" });
		expect(decodeNativeReadResult(nativeReadStep({ output: "Tool view_file failed with error message: example" }), 1))
			.toMatchObject({ status: "completed" });
	});

	it.each([
		{ status: 2 }, { responseJson: "not JSON" }, { responseJson: "{}" },
		{ responseJson: '{"result":{"path":"/workspace/file.ts"}}' },
		{ responseType: "type.googleapis.com/other.ToolResponse" },
		{ completedAt: observedAt - 1 }, { input: { AbsolutePath: "../relative" } },
	])("does not infer success from an incomplete or unknown envelope: %s", (options) => {
		expect(decodeNativeReadResult(nativeReadStep(options), 1)).toBeUndefined();
	});

	it("rejects truncated, malformed and duplicate protobuf fields", () => {
		const payload = nativeReadStep();
		for (const bytes of [payload.subarray(0, payload.length - 1), Buffer.from([0x80]),
			Buffer.from([0x0a, 0xff, 0xff, 0xff]), Buffer.concat([payload, field(4, 3)])]) {
			expect(decodeNativeReadResult(bytes, 1)).toBeUndefined();
		}
	});

	it("bounds the persisted preview without hiding the actual status", () => {
		const result = decodeNativeReadResult(nativeReadStep({ output: "x".repeat(100_000) }), 1)!;
		expect(result.status).toBe("completed");
		expect(result.output.length).toBeLessThan(66_000);
		expect(result.output).toContain("preview truncated");
	});

	it("matches both argument spellings while ignoring toolSummary", () => {
		const result = decodeNativeReadResult(nativeReadStep({ input: {
			absolute_path: "/workspace/file.ts", start_line: 1, end_line: 10, toolSummary: "Read",
		} }), 1)!;
		expect(matchNativeReadResult([result], call, observedAt)).toBe(result);
	});

	it("requires the ID, path, range and timestamp to match", () => {
		const result = decodeNativeReadResult(nativeReadStep(), 1)!;
		for (const other of [
			{ ...call, toolCallId: "other" },
			{ ...call, rawInput: { ...call.rawInput, AbsolutePath: "/workspace/other.ts" } },
			{ ...call, rawInput: { ...call.rawInput, StartLine: 2 } },
			{ ...call, rawInput: { ...call.rawInput, EndLine: 20 } },
		]) expect(matchNativeReadResult([result], other, observedAt)).toBeUndefined();
		expect(matchNativeReadResult([result], call, observedAt + 10_000)).toBeUndefined();
		expect(matchNativeReadResult([result], call, observedAt - 10_000)).toBeUndefined();
		expect(matchNativeReadResult([result], call, NaN)).toBeUndefined();
	});

	it("does not guess between duplicate IDs and identical overlapping reads", () => {
		const first = decodeNativeReadResult(nativeReadStep(), 1)!;
		const second = { ...first, stepIndex: 2 };
		expect(matchNativeReadResult([first, second], call, observedAt)).toBeUndefined();
		const later = { ...second, startedAt: observedAt + 10_000, completedAt: observedAt + 10_100 };
		expect(matchNativeReadResult([first, later], call, observedAt + 10_000)).toBe(later);
	});
});

describe.skipIf(!sqlite)("read-only upstream database", () => {
	function database() {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-read-evidence-"));
		directories.push(home);
		vi.stubEnv("GEMINI_HOME", home);
		const directory = path.join(home, "antigravity-acp", "conversations");
		fs.mkdirSync(directory, { recursive: true });
		const filename = path.join(directory, `${sessionId}.db`);
		const db = new sqlite!.DatabaseSync(filename);
		db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB)");
		return { filename, db };
	}

	it("reads only completed native steps and does not change the stored database", async () => {
		const { filename, db } = database();
		const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?)");
		insert.run(1, 103, 3, 0, nativeReadStep());
		insert.run(2, 103, 3, 0, nativeReadStep({ error: "No such file" }));
		insert.run(3, 103, 2, 0, nativeReadStep());
		insert.run(4, 103, 3, 1, nativeReadStep());
		insert.run(5, 3, 3, 0, nativeReadStep());
		insert.run(6, 103, 3, 0, Buffer.from("malformed"));
		db.close();
		const before = fs.readFileSync(filename);
		const result = await readNativeReadResults(sessionId);
		expect(result.map((item) => [item.stepIndex, item.status])).toEqual([[2, "failed"], [1, "completed"]]);
		expect(fs.readFileSync(filename)).toEqual(before);
	});

	it("sees WAL commits while the server keeps its connection open", async () => {
		const { db } = database();
		try {
			db.exec("PRAGMA journal_mode = WAL");
			db.prepare("INSERT INTO steps VALUES (1, 103, 3, 0, ?)").run(nativeReadStep());
			expect(await readNativeReadResults(sessionId)).toHaveLength(1);
			db.prepare("INSERT INTO steps VALUES (2, 103, 3, 0, ?)").run(nativeReadStep({ id: "other" }));
			expect(await readNativeReadResults(sessionId)).toHaveLength(2);
		} finally { db.close(); }
	});

	it("falls back safely for missing, corrupt, locked and incompatible stores", async () => {
		const { filename, db } = database();
		try {
			db.exec("BEGIN EXCLUSIVE");
			expect(await readNativeReadResults(sessionId)).toEqual([]);
			db.exec("ROLLBACK; DROP TABLE steps");
			expect(await readNativeReadResults(sessionId)).toEqual([]);
		} finally { db.close(); }
		fs.writeFileSync(filename, "corrupt sqlite");
		expect(await readNativeReadResults(sessionId)).toEqual([]);
		fs.unlinkSync(filename);
		expect(await readNativeReadResults(sessionId)).toEqual([]);
		expect(fs.existsSync(filename)).toBe(false);
		expect(await readNativeReadResults("../../outside")).toEqual([]);
	});
});
