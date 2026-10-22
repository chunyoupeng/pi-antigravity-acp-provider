import { type Message, type Model, normalizeContext } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import type { ToolOwner } from "../src/config.js";
import { MCP_MAX_OUTPUT_BYTES, projectModels } from "../src/models.js";
import { AntigravityRuntime, PI_OWNED_NATIVE_TOOLS, PI_TOOL_DESCRIPTIONS, UNUSED_NATIVE_TOOLS } from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_192,
};

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function runtimeFor(scenario: string, toolOwner: ToolOwner = "pi", store?: AcpSessionStore): AntigravityRuntime {
	return new AntigravityRuntime(
		(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, scenario] }),
		"yolo",
		store,
		undefined,
		toolOwner,
	);
}

async function ask(runtime: AntigravityRuntime, text: string, sessionId?: string, history: Message[] = []) {
	const writer = runtime.stream(
		model,
		normalizeContext({ messages: [...history, { role: "user", content: text, timestamp: history.length + 1 }] }),
		{ apiKey: "test-key", ...(sessionId ? { sessionId } : {}) },
	);
	for await (const _event of writer.stream) void _event;
	const block = writer.message.content.find((item) => item.type === "text");
	return { message: writer.message, text: block?.type === "text" ? block.text : "" };
}

describe("Pi takeover of Antigravity capabilities", () => {
	it("disables the built-ins Pi replaces and keeps client fs off", async () => {
		const runtime = runtimeFor("default");
		try {
			const echoed = JSON.parse((await ask(runtime, "inspect meta")).text);
			expect(echoed.meta.new).toEqual({ antigravity: { disabledTools: [...PI_OWNED_NATIVE_TOOLS, ...UNUSED_NATIVE_TOOLS], eagerMcpServers: ["pi-bridge"], mcpMaxOutputBytes: MCP_MAX_OUTPUT_BYTES } });
			expect(echoed.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
		} finally {
			await runtime.close();
		}
	});

	it("keeps built-ins in native mode, clears any persisted filter, and serves fs", async () => {
		const runtime = runtimeFor("default", "native");
		try {
			const echoed = JSON.parse((await ask(runtime, "inspect meta")).text);
			expect(echoed.meta.new).toEqual({ antigravity: { disabledTools: [...UNUSED_NATIVE_TOOLS], eagerMcpServers: ["pi-bridge"], mcpMaxOutputBytes: MCP_MAX_OUTPUT_BYTES } });
			expect(echoed.clientCapabilities.fs).toEqual({ readTextFile: true, writeTextFile: true });
		} finally {
			await runtime.close();
		}
	});

	it("serves fs reads and writes inside the workspace and rejects paths outside it", async () => {
		const workspace = fs.mkdtempSync(path.join(process.cwd(), ".fs-test-"));
		directories.push(workspace);
		fs.writeFileSync(path.join(workspace, "a.txt"), "one\ntwo\nthree\n");
		const runtime = runtimeFor("default", "native");
		try {
			expect(JSON.parse((await ask(runtime, `fs read ${path.join(workspace, "a.txt")}`)).text)).toEqual({ content: "two" });
			const target = path.join(workspace, "nested", "b.txt");
			expect(JSON.parse((await ask(runtime, `fs write ${target}`)).text)).toEqual({});
			expect(fs.readFileSync(target, "utf8")).toBe("written by agent\n");
			const outside = JSON.parse((await ask(runtime, "fs read /etc/hosts")).text);
			expect(outside.error).toMatch(/Invalid params/u);
		} finally {
			await runtime.close();
		}
	});

	it("reports usage_update as Pi context usage when the prompt has no token counts", async () => {
		const runtime = runtimeFor("default");
		try {
			const { message } = await ask(runtime, "report usage");
			expect(message.usage).toMatchObject({ input: 1234, output: 0, totalTokens: 1234 });
			expect((await runtime.snapshot()).metrics.latestContext).toEqual({ used: 1234, size: 100000 });
		} finally {
			await runtime.close();
		}
	});

	it("rebuilds from Pi's context after the harness replaces history with its own summary", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-checkpoint-"));
		directories.push(home);
		const acpSessionId = "0aba03aa-84de-4119-976a-b7ef85cc4727";
		const logs = path.join(home, "antigravity-acp", "brain", acpSessionId, ".system_generated", "logs");
		fs.mkdirSync(logs, { recursive: true });
		const transcript = path.join(logs, "transcript_full.jsonl");
		const planner = JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 1234, cache_read_tokens: 0, output_tokens: 0 });
		fs.writeFileSync(transcript, `${planner}\n`);
		const saved = { home: process.env.GEMINI_HOME, id: process.env.FAKE_SESSION_ID };
		process.env.GEMINI_HOME = home;
		process.env.FAKE_SESSION_ID = acpSessionId;
		const runtime = runtimeFor("default");
		const text = (message: { content: Array<{ type: string; text?: string }> }) => message.content.map((block) => block.text ?? "").join("");
		try {
			const history: Message[] = [];
			const turn = async (prompt: string) => {
				const timestamp = history.length + 1;
				const { message } = await ask(runtime, prompt, "harness-checkpoint", history);
				history.push({ role: "user", content: prompt, timestamp }, message);
				return message;
			};
			expect(text(await turn("report usage"))).not.toContain("own summary");
			fs.appendFileSync(transcript, `${JSON.stringify({ step_index: 2, type: "CHECKPOINT", content: "harness summary" })}\n${planner}\n`);
			expect(text(await turn("report usage"))).toContain("Antigravity replaced this conversation's history with its own summary");
			const generation = (await runtime.snapshot()).processes[0]?.generation;
			const rebuilt = text(await turn("inspect context"));
			expect(rebuilt).toContain("# Prior conversation");
			expect(rebuilt).toContain("counted");
			expect((await runtime.snapshot()).processes[0]?.generation).not.toBe(generation);
		} finally {
			await runtime.close();
			if (saved.home === undefined) delete process.env.GEMINI_HOME;
			else process.env.GEMINI_HOME = saved.home;
			if (saved.id === undefined) delete process.env.FAKE_SESSION_ID;
			else process.env.FAKE_SESSION_ID = saved.id;
		}
	});

	it("discovers thinking levels and selects them through the family and thinking_level selectors", async () => {
		const runtime = runtimeFor("thinking-levels");
		try {
			const models = projectModels(await runtime.discoverModels("test-key"));
			const flash = models.find((candidate) => candidate.id === "gemini-flash");
			expect(flash).toMatchObject({ id: "gemini-flash", reasoning: true });
			expect(flash?.thinkingLevelMap).toMatchObject({ low: "gemini-flash-low", medium: "gemini-flash-medium", high: "gemini-flash-high" });
			const first = runtime.stream(
				flash!,
				normalizeContext({ messages: [{ role: "user", content: "inspect meta", timestamp: 1 }] }),
				{ apiKey: "test-key", reasoning: "low", sessionId: "thinking-session" },
			);
			for await (const _event of first.stream) void _event;
			expect(first.message.stopReason).toBe("stop");
			const firstBlock = first.message.content.find((item) => item.type === "text");
			expect(JSON.parse(firstBlock?.type === "text" ? firstBlock.text : "").selectionMethods).toEqual([
				"set_config_option:permission-selector=yolo",
				"set_config_option:model=gemini-flash",
				"set_config_option:thinking_level=low",
			]);
			// Changing only the thinking level on the same family skips re-setting the model selector.
			const second = runtime.stream(
				flash!,
				normalizeContext({
					messages: [
						{ role: "user", content: "inspect meta", timestamp: 1 },
						first.message,
						{ role: "user", content: "inspect meta", timestamp: 2 },
					],
				}),
				{ apiKey: "test-key", reasoning: "medium", sessionId: "thinking-session" },
			);
			for await (const _event of second.stream) void _event;
			expect(second.message.stopReason).toBe("stop");
			const secondBlock = second.message.content.find((item) => item.type === "text");
			expect(JSON.parse(secondBlock?.type === "text" ? secondBlock.text : "").selectionMethods).toEqual([
				"set_config_option:permission-selector=yolo",
				"set_config_option:model=gemini-flash",
				"set_config_option:thinking_level=low",
				"set_config_option:thinking_level=medium",
			]);
		} finally {
			await runtime.close();
		}
	});

	it("selects models through config options and records server-side replacements", async () => {
		const runtime = runtimeFor("config-options");
		try {
			const { message } = await ask(runtime, "change model", "config-session");
			expect(message.responseModel).toBe("gemini-other");
			// The next turn of the same conversation re-applies Pi's selection.
			const history: Message[] = [{ role: "user", content: "change model", timestamp: 1 }, message];
			const echoed = JSON.parse((await ask(runtime, "inspect meta", "config-session", history)).text);
			expect(echoed.selectionMethods).toEqual([
				"set_config_option:permission-selector=yolo",
				"set_config_option:model-selector=gemini-test",
				"set_config_option:model-selector=gemini-test",
			]);
		} finally {
			await runtime.close();
		}
	});

	it("lists Antigravity sessions and resumes an attached one with the tool filter", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-attach-"));
		directories.push(directory);
		const store = new AcpSessionStore(path.join(directory, "sessions.json"));
		const runtime = runtimeFor("default", "pi", store);
		try {
			expect(await runtime.listSessions(process.cwd())).toEqual([
				{ sessionId: "listed-session", cwd: process.cwd(), title: "Session listed-s" },
			]);
			await runtime.attachSession("pi-session", "listed-session");
			const echoed = JSON.parse((await ask(runtime, "inspect meta", "pi-session")).text);
			expect(echoed.sessionId).toBe("listed-session");
			expect(echoed.meta.resume).toEqual({ antigravity: { disabledTools: [...PI_OWNED_NATIVE_TOOLS, ...UNUSED_NATIVE_TOOLS], eagerMcpServers: ["pi-bridge"], mcpMaxOutputBytes: MCP_MAX_OUTPUT_BYTES } });
		} finally {
			await runtime.close();
		}
	});

	it("approves Antigravity's permission prompt for bridged Pi tools once, without asking Pi", async () => {
		const runtime = runtimeFor("default");
		try {
			const writer = runtime.stream(
				model,
				normalizeContext({
					messages: [{ role: "user", content: "pi tool permission", timestamp: 1 }],
					tools: [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }],
				}),
				{ apiKey: "test-key" },
			);
			for await (const _event of writer.stream) void _event;
			expect(writer.message.stopReason).toBe("stop");
			expect(writer.message.content).toEqual([{ type: "text", text: "Decision: selected" }]);
		} finally {
			await runtime.close();
		}
	});

	it("steers Pi's read and bash descriptions when Pi owns tools while preserving Codemode call hints", async () => {
		const readCodemode = "\n\nCodemode: `tools.read(args)` resolves to a string.";
		const tools = [
			{ name: "read", description: `Read a file${readCodemode}`, parameters: Type.Object({ path: Type.String() }) },
			{ name: "bash", description: "Run a shell command", parameters: Type.Object({ command: Type.String() }) },
			{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
		];
		for (const [owner, read, bash] of [
			["pi", `${PI_TOOL_DESCRIPTIONS.read}${readCodemode}`, PI_TOOL_DESCRIPTIONS.bash],
			["native", `Read a file${readCodemode}`, "Run a shell command"],
		] as const) {
			const runtime = runtimeFor("default", owner);
			try {
				const writer = runtime.stream(
					model,
					normalizeContext({ messages: [{ role: "user", content: "list bridge tools", timestamp: 1 }], tools }),
					{ apiKey: "test-key" },
				);
				for await (const _event of writer.stream) void _event;
				const block = writer.message.content.find((item) => item.type === "text");
				expect(JSON.parse(block?.type === "text" ? block.text : "")).toEqual([
					{ name: "pi_read", description: read },
					{ name: "pi_bash", description: bash },
					{ name: "pi_echo", description: "Echo text" },
				]);
			} finally {
				await runtime.close();
			}
		}
	});

	it("uses the ACP logout method when the server advertises it", async () => {
		const runtime = runtimeFor("default");
		try {
			expect(await runtime.logout()).toEqual({ server: true });
		} finally {
			await runtime.close();
		}
	});
});
