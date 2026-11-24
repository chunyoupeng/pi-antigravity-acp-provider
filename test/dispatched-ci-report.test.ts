import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = fileURLToPath(new URL("../scripts/report-dispatched-ci.mjs", import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function report(env: Record<string, string> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatched-ci-report-"));
	roots.push(root);
	const log = path.join(root, "calls.jsonl");
	fs.writeFileSync(log, "");
	fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
	fs.writeFileSync(path.join(root, "gh"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
const url = "https://github.com/chunyoupeng/pi-antigravity-acp-provider/actions/runs/123";
if (args.includes("POST")) console.log("{}");
else if (args[1].includes("/jobs?")) console.log(JSON.stringify({ jobs: ["Check (22.19.0)", "Check (24)"].map((name, index) => ({ name, status: "completed", conclusion: index === 1 && process.env.FAILED_JOB === "true" ? "failure" : "success", html_url: url + "/job/" + index })).filter((_, i) => !(i === 1 && process.env.MISSING_JOB === "true")) }));
else console.log(JSON.stringify({ id: 123, head_sha: process.env.WRONG_SHA === "true" ? "b".repeat(40) : "a".repeat(40), event: process.env.WRONG_EVENT === "true" ? "pull_request" : "workflow_dispatch", html_url: url }));
`, { mode: 0o755 });
	const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: {
		...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, CALL_LOG: log,
		GITHUB_REPOSITORY: "chunyoupeng/pi-antigravity-acp-provider", GITHUB_RUN_ID: "123", GITHUB_SHA: "a".repeat(40), ...env,
	} });
	const posts = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((args) => args.includes("POST"));
	return { result, posts };
}

describe.skipIf(process.platform === "win32")("report real dispatched CI jobs", () => {
	it("records successful real jobs with their exact tested commit and job URLs", () => {
		const { result, posts } = report();
		expect(result.status, result.stderr).toBe(0);
		expect(posts).toHaveLength(2);
		for (const post of posts) {
			expect(post).toContain(`repos/chunyoupeng/pi-antigravity-acp-provider/statuses/${"a".repeat(40)}`);
			expect(post).toContain("state=success");
			expect(post.some((arg) => arg.startsWith("target_url=https://github.com/chunyoupeng/pi-antigravity-acp-provider/actions/runs/123/job/"))).toBe(true);
		}
	});

	it.each([{ FAILED_JOB: "true" }, { MISSING_JOB: "true" }])("never reports failed or missing validation as successful: %j", (env) => {
		const { result, posts } = report(env);
		expect(result.status, result.stderr).toBe(0);
		expect(posts[1]).toContain("state=failure");
	});

	it.each([{ WRONG_SHA: "true" }, { WRONG_EVENT: "true" }])("refuses to attest a different commit/event: %j", (env) => {
		const { result, posts } = report(env);
		expect(result.status).not.toBe(0);
		expect(posts).toHaveLength(0);
	});
});
