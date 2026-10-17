import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contextTokensInUse, transcriptCheckpoints } from "../src/acp/transcript-usage.js";

const sessionId = "f322dda8-074f-4e54-86ee-4d90ccbcd1b7";
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function profileWith(lines: string[]): string {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-usage-"));
	directories.push(profile);
	const logs = path.join(profile, "brain", sessionId, ".system_generated", "logs");
	fs.mkdirSync(logs, { recursive: true });
	fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), `${lines.join("\n")}\n`);
	return profile;
}

const planner = (step: number, input: number, cache: number, output: number) => JSON.stringify({
	step_index: step, type: "PLANNER_RESPONSE", input_tokens: input, cache_read_tokens: cache, output_tokens: output,
});

describe("contextTokensInUse", () => {
	it("removes the second count of cached tokens from usage_update", async () => {
		// Recorded from a live server: used 93229 = 3308 + 2 × 44955 + 11.
		const profile = profileWith([
			JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "hi" }),
			planner(1, 48137, 0, 55),
			JSON.stringify({ step_index: 2, type: "USER_INPUT", content: "again" }),
			planner(3, 3308, 44955, 11),
		]);
		await expect(contextTokensInUse(sessionId, 93229, profile, [])).resolves.toBe(48274);
		await expect(contextTokensInUse(sessionId, 48192, profile, [])).resolves.toBe(48192);
	});

	it("matches an earlier step when a later one is already written", async () => {
		const profile = profileWith([planner(1, 2988, 11414, 277), planner(3, 8257, 14490, 256)]);
		await expect(contextTokensInUse(sessionId, 2988 + 2 * 11414 + 277, profile, [])).resolves.toBe(2988 + 11414 + 277);
	});

	it("keeps the reported count when nothing in the transcript explains it", async () => {
		const profile = profileWith([planner(1, 3308, 44955, 11)]);
		await expect(contextTokensInUse(sessionId, 50_000, profile, [])).resolves.toBe(50_000);
		await expect(contextTokensInUse("01a14810-0000-0000-0000-000000000000", 93229, profile)).resolves.toBe(93229);
		await expect(contextTokensInUse("../escape", 93229, profile)).resolves.toBe(93229);
	});

	it("waits for a step the server reports before writing it", async () => {
		const profile = profileWith([planner(1, 48137, 0, 55)]);
		const transcript = path.join(profile, "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl");
		setTimeout(() => fs.appendFileSync(transcript, `${planner(3, 26696, 412214, 67)}\n`), 30);
		await expect(contextTokensInUse(sessionId, 851191, profile, [50, 100])).resolves.toBe(438977);
	});

	it("reports the harness count when the content is lighter in tokens than in characters", async () => {
		const profile = profileWith([
			JSON.stringify({ step_index: 2, type: "MCP_TOOL", content: "x".repeat(260_000) }),
			planner(3, 1000, 2000, 10),
		]);
		await expect(contextTokensInUse(sessionId, 5010, profile, [])).resolves.toBe(100_000);
	});

	it("counts UTF-8 bytes as the harness does for Chinese text", async () => {
		const profile = profileWith([
			JSON.stringify({ step_index: 2, type: "MCP_TOOL", content: "汉".repeat(86_667) }),
			planner(3, 1000, 2000, 10),
		]);
		await expect(contextTokensInUse(sessionId, 5010, profile, [])).resolves.toBe(100_001);
	});

	it("adds the bytes the transcript dropped from a long record", async () => {
		const profile = profileWith([
			JSON.stringify({ step_index: 0, type: "USER_INPUT", content: `${"x".repeat(192_000)}\n<truncated 68000 bytes>\n` }),
			planner(1, 1000, 0, 10),
		]);
		await expect(contextTokensInUse(sessionId, 1010, profile, [])).resolves.toBe(Math.ceil((192_000 + 25 + 68_000) / 2.6));
	});

	it("keeps counting through the harness's checkpoint so Pi compacts", async () => {
		const profile = profileWith([
			JSON.stringify({ step_index: 2, type: "MCP_TOOL", content: "x".repeat(260_000) }),
			JSON.stringify({ step_index: 3, type: "CHECKPOINT", content: "s".repeat(26_000) }),
			planner(5, 100, 200, 0),
		]);
		await expect(contextTokensInUse(sessionId, 500, profile, [])).resolves.toBe(110_000);
		expect(transcriptCheckpoints(sessionId, profile)).toBe(1);
	});
});
