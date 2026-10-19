import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/diagnose-session.mjs", import.meta.url));
const PI = "01a1546d-9702-714e-ada8-442e937aea6c";
const ACP = "a0aa0902-5bd9-474f-b14d-5f586bd18b4f";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const jsonl = (entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const assistant = (timestamp: string, totalTokens: number, extra: object = {}) => ({
	type: "message", timestamp, message: { role: "assistant", content: [], usage: { totalTokens }, stopReason: "toolUse", ...extra },
});

describe("diagnose-session script", () => {
	it("flags a stall that replays Pi's history into the resumed session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnose-session-")); roots.push(root);
		const agent = path.join(root, "agent");
		const sessions = path.join(agent, "sessions", "--work--");
		fs.mkdirSync(sessions, { recursive: true });
		const sessionFile = path.join(sessions, `2026-10-19T14-37-00-000Z_${PI}.jsonl`);
		fs.writeFileSync(sessionFile, jsonl([
			{ type: "session", id: PI, cwd: "/work" },
			{ type: "message", timestamp: "2026-10-19T14:37:00Z", message: { role: "user", content: "fix the cover" } },
			assistant("2026-10-19T14:37:41Z", 51_439),
			assistant("2026-10-19T14:40:54Z", 0, { stopReason: "error", errorMessage: "session/prompt timed out" }),
			{ type: "message", timestamp: "2026-10-19T14:45:00Z", message: { role: "user", content: "go on" } },
			assistant("2026-10-19T14:45:29Z", 183_152, { stopReason: "stop" }),
		]));
		const logs = path.join(agent, "antigravity-acp-provider", "logs");
		fs.mkdirSync(logs, { recursive: true });
		fs.writeFileSync(path.join(logs, "bindings.jsonl"), jsonl([
			{ t: "2026-10-19T14:37:25Z", event: "bind", pi: PI, acp: ACP, how: "new", messageCount: 0, model: "m" },
			{ t: "2026-10-19T14:37:25Z", event: "prompt", pi: PI, acp: ACP, fresh: true, from: 0, to: 40, bytes: 96_733 },
			{ t: "2026-10-19T14:40:54Z", event: "exit", pi: PI, acp: ACP, signal: "SIGTERM" },
			{ t: "2026-10-19T14:41:42Z", event: "bind", pi: PI, acp: ACP, how: "resume", messageCount: 0, model: "m" },
			{ t: "2026-10-19T14:41:42Z", event: "prompt", pi: PI, acp: ACP, fresh: true, from: 0, to: 41, bytes: 99_397 },
			{ t: "2026-10-19T14:41:42Z", event: "bind", pi: "someone-else", acp: "b", how: "new", messageCount: 0, model: "m" },
		]));
		const transcript = path.join(root, "gemini", "antigravity-acp", "brain", ACP, ".system_generated", "logs");
		fs.mkdirSync(transcript, { recursive: true });
		const history = "<USER_REQUEST>\nEmbedded resource (urn:pi:antigravity-acp:context/1):\n...</USER_REQUEST>";
		fs.writeFileSync(path.join(transcript, "transcript_full.jsonl"), jsonl([
			{ step_index: 0, type: "USER_INPUT", created_at: "2026-10-19T14:37:25Z", content: history },
			{ step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-10-19T14:37:25Z", input_tokens: 51_286, cache_read_tokens: 0, output_tokens: 153 },
			{ step_index: 2, type: "ERROR_MESSAGE", created_at: "2026-10-19T14:38:12Z", error: "The model is currently unreachable.", error_code: 502 },
			{ step_index: 3, type: "ERROR_MESSAGE", created_at: "2026-10-19T14:38:33Z", error: "The model is currently unreachable.", error_code: 502 },
			{ step_index: 4, type: "USER_INPUT", created_at: "2026-10-19T14:41:42Z", content: history },
			{ step_index: 5, type: "PLANNER_RESPONSE", created_at: "2026-10-19T14:45:00Z", input_tokens: 44_575, cache_read_tokens: 136_374, output_tokens: 2_203 },
		]));

		const output = execFileSync(process.execPath, [script, PI.slice(0, 8)], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agent, GEMINI_HOME: path.join(root, "gemini"), TZ: "Asia/Shanghai" },
			encoding: "utf8",
		});

		expect(output).toContain("ACP         a0aa0902 via decision log");
		expect(output).toContain("22:41:42  dec:a0aa0902  bind resume messageCount=0");
		expect(output).toContain("!! full Pi history sent into a session restored by resume");
		expect(output).toContain("!! Pi history replayed into a session that already has 4 steps");
		expect(output).toContain("backend error 502 The model is currently unreachable. x2 until 22:38:33");
		expect(output).toContain("!! context +132k in one step (51.4k -> 183k)");
		expect(output).toContain("4 flagged:");
		expect(output).not.toContain("someone-else");
	});
});
