import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
	AGY_CLI_AGENT_NAME,
	AGY_CLI_NATIVE_TOOLS,
	resolveAntigravityAcpLaunch,
} from "../src/acp/antigravity.js";
import { resolveSupervisorEntry } from "../src/acp/process.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-launch-"));
	roots.push(dir);
	return dir;
}

function makeExecutable(filePath: string, body = "#!/bin/sh\nexit 0\n"): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, { mode: 0o755 });
}

describe("agy CLI ACP launch", () => {
	it("resolves agy CLI from ~/.local/bin and writes the minimal custom agent", () => {
		const home = makeRoot();
		const agy = path.join(home, ".local", "bin", "agy");
		makeExecutable(agy);

		const launch = resolveAntigravityAcpLaunch({
			dangerouslySkipPermissions: true,
			env: { HOME: home, PATH: "" },
		});
		expect(launch).toEqual({
			command: agy,
			args: [
				"acp",
				"--process-per-session",
				"--agent",
				AGY_CLI_AGENT_NAME,
				"--disable-telemetry",
				"--dangerously-skip-permissions",
			],
			source: "user-bin",
		});

		const agentFile = path.join(home, ".gemini", "antigravity-cli", "agents", AGY_CLI_AGENT_NAME, "agent.md");
		const content = fs.readFileSync(agentFile, "utf8");
		expect(content).toContain("excludeDefaultComponents: true");
		expect(content).toContain("You are Antigravity");
		for (const tool of AGY_CLI_NATIVE_TOOLS) expect(content).toContain(`- ${tool}`);
	});

	it("omits --dangerously-skip-permissions when yolo is off and resolves from PATH", () => {
		const home = makeRoot();
		const agy = path.join(home, "bin", "agy");
		makeExecutable(agy);

		const launch = resolveAntigravityAcpLaunch({
			dangerouslySkipPermissions: false,
			env: { HOME: home, PATH: path.dirname(agy) },
		});
		expect(launch).toEqual({
			command: agy,
			args: [
				"acp",
				"--process-per-session",
				"--agent",
				AGY_CLI_AGENT_NAME,
				"--disable-telemetry",
			],
			source: "path",
		});
	});

	it("throws a clear spawn error when agy CLI is absent", () => {
		const home = makeRoot();
		expect(() => resolveAntigravityAcpLaunch({ env: { HOME: home, PATH: "" } })).toThrow(/agy/u);
	});

	it("forwards --cloud_code_endpoint from supervisor CCPA relay to agy acp", async () => {
		const dir = makeRoot();
		const fakeAgy = path.join(dir, "agy");
		makeExecutable(fakeAgy, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);

		const { stdout } = await execFileAsync(
			process.execPath,
			[resolveSupervisorEntry(), "--command", fakeAgy, "acp", "--process-per-session"],
			{
				env: {
					...process.env,
					AGY_ACP_CCPA_BASE_URL: "http://127.0.0.1:43210",
				},
			},
		);
		const args = JSON.parse(stdout.trim()) as string[];
		expect(args).toEqual([
			"acp",
			"--process-per-session",
			"--cloud_code_endpoint",
			"http://127.0.0.1:43210",
		]);
	});
});
