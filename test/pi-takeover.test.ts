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
import { AntigravityRuntime, PI_OWNED_NATIVE_TOOLS, UNUSED_NATIVE_TOOLS } from "../src/runtime.js";

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
			expect(echoed.meta.new).toEqual({ agy: { disabledTools: [...PI_OWNED_NATIVE_TOOLS, ...UNUSED_NATIVE_TOOLS] } });
			expect(echoed.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
		} finally {
			await runtime.close();
		}
	});

	it("keeps built-ins in native mode, clears any persisted filter, and serves fs", async () => {
		const runtime = runtimeFor("default", "native");
		try {
			const echoed = JSON.parse((await ask(runtime, "inspect meta")).text);
			expect(echoed.meta.new).toEqual({ agy: { disabledTools: [...UNUSED_NATIVE_TOOLS] } });
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
			expect(echoed.meta.resume).toEqual({ agy: { disabledTools: [...PI_OWNED_NATIVE_TOOLS, ...UNUSED_NATIVE_TOOLS] } });
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

	it("uses the ACP logout method when the server advertises it", async () => {
		const runtime = runtimeFor("default");
		try {
			expect(await runtime.logout()).toEqual({ server: true });
		} finally {
			await runtime.close();
		}
	});
});
