import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import type { AcpToolActivity } from "../src/acp/events.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import {
	AntigravityRuntime,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
} from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};

describe("AntigravityRuntime", () => {
	it("discovers and runs models on a config-options-only ACP server", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "config-options"] }),
		);
		try {
			expect(await runtime.discoverModels("test-key")).toEqual([
				{ modelId: "auto", name: "Auto" }, { modelId: "gemini-test", name: "Gemini Test" },
			]);
			const first = runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "test-key", sessionId: "modern-session" });
			for await (const _event of first.stream) void _event;
			expect(first.message.stopReason).toBe("stop");
			expect((await runtime.snapshot()).processes[0]?.modelId).toBe("gemini-test");
			await runtime.setPermissionMode("default");
			expect((await runtime.snapshot()).permissionMode).toBe("default");
		} finally {
			await runtime.close();
		}
	});

	it("forwards full native tool activities and ordered raw events without executable calls or thinking", async () => {
		const activities: AcpToolActivity[] = [];
		const raw: string[] = [];
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "native-tools"] }),
			"yolo", undefined, (activity) => activities.push(activity),
		);
		try {
			const writer = runtime.stream(model, normalizeContext({ systemPrompt: "Project rules", messages: [{ role: "user", content: "hello", timestamp: 1 }] }), {
				sessionId: "native-session", apiKey: "test-key",
				async onProviderStreamEvent(data, receivedModel) {
					expect(receivedModel).toBe(model);
					await new Promise((resolve) => setTimeout(resolve, 15));
					raw.push((data as { update: { sessionUpdate: string } }).update.sessionUpdate);
				},
			});
			for await (const _event of writer.stream) void _event;
			expect(raw).toEqual(["tool_call", "tool_call_update", "agent_thought_chunk", "agent_message_chunk"]);
			expect(activities).toHaveLength(2);
			expect(activities[0]).toMatchObject({ piSessionId: "native-session", toolCall: { status: "in_progress", rawInput: { command: "echo hello" } } });
			expect(activities[1]?.toolCall).toMatchObject({ title: "Run command", status: "completed", rawInput: { command: "echo hello" }, rawOutput: { exitCode: 0, stdout: "hello" }, locations: [{ path: "src/a.ts", line: 2 }] });
			expect(JSON.stringify(activities[1])).toContain("output".repeat(1000));
			expect(writer.message.content).toEqual([{ type: "thinking", thinking: "Checking" }, { type: "text", text: "Hello" }]);
			expect(writer.message.stopReason).toBe("stop");
		} finally {
			await runtime.close();
		}
	});

	it("retains normalized project instructions when ACP only accepts plain text", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "text-only"] }),
		);
		try {
			const writer = runtime.stream(model, {
				messages: [{ role: "system", content: "AGENTS.md rules", sections: { project: "Keep changes small" }, timestamp: 0 }, { role: "user", content: "inspect context", timestamp: 1 }],
			}, { apiKey: "test-key" });
			for await (const _event of writer.stream) void _event;
			const content = writer.message.content[0];
			if (content?.type !== "text") throw new Error("missing echoed prompt");
			expect(JSON.parse(content.text)).toEqual([{ type: "text", text: "# Pi session instructions\n\nAGENTS.md rules\n\nKeep changes small" }, { type: "text", text: "inspect context" }]);
		} finally {
			await runtime.close();
		}
	});

	it("rejects image input when ACP does not advertise support", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "text-only"] }),
		);
		try {
			const writer = runtime.stream(model, { messages: [{ role: "user", content: [{ type: "image", data: "AQ==", mimeType: "image/png" }], timestamp: 1 }] }, { apiKey: "test-key" });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringContaining("did not advertise image input") } });
		} finally {
			await runtime.close();
		}
	});

	it("recognizes Gemini CLI's advertised Google login method", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			await expect(runtime.loginGoogle()).resolves.toBeUndefined();
		} finally {
			await runtime.close();
		}
	});

	it("relays Google login through Pi on a headless host", async () => {
		const previousMode = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const runtime = new AntigravityRuntime(
			(options) =>
				new AntigravityAcpConnection({
					...options,
					command: process.execPath,
					args: [fakeAgent, "headless-auth"],
				}),
		);
		let shownUrl: string | undefined;
		try {
			await runtime.loginGoogle(undefined, undefined, {
				showAuthorizationUrl(url) {
					shownUrl = url;
				},
				promptForCallback: async () => {
					if (!shownUrl) throw new Error("authorization URL was not shown");
					const authorization = new URL(shownUrl);
					const redirect = authorization.searchParams.get("redirect_uri");
					const state = authorization.searchParams.get("state");
					if (!redirect || !state) throw new Error("authorization URL is incomplete");
					return `${redirect}?state=${encodeURIComponent(state)}&code=fake-code`;
				},
			});
			expect(shownUrl).toMatch(/^https:\/\/accounts\.google\.com\//u);
		} finally {
			await runtime.close();
			if (previousMode === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previousMode;
		}
	});

	it("does not prompt when headless login reuses cached authentication", async () => {
		const previousMode = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		const progress: string[] = [];
		try {
			await runtime.loginGoogle(undefined, (message) => progress.push(message), {
				showAuthorizationUrl() {
					throw new Error("cached authentication unexpectedly showed a URL");
				},
				promptForCallback: async () => {
					throw new Error("cached authentication unexpectedly prompted");
				},
			});
			expect(progress).toContain("Antigravity reused the saved Google login.");
		} finally {
			await runtime.close();
			if (previousMode === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previousMode;
		}
	});

	it("maps a complete ACP turn into balanced Pi events", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const context: Context = {
				systemPrompt: "Be useful",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			};
			const writer = runtime.stream(model, context, { sessionId: "pi-session", apiKey: "test-key" });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.map((event) => event.type)).toEqual([
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_end",
				"text_start",
				"text_delta",
				"text_end",
				"done",
			]);
			const done = events.at(-1);
			expect(done).toMatchObject({
				type: "done",
				message: { usage: { input: 7, output: 3, totalTokens: 10 }, rawStopReason: "end_turn" },
			});
			const snapshot = await runtime.snapshot();
			expect(snapshot.bindings).toBe(1);
			expect(snapshot.permissionMode).toBe("yolo");
			expect(snapshot.processes[0]).toMatchObject({ modelId: "gemini-test", alive: true });
			await runtime.setPermissionMode("default");
			expect((await runtime.snapshot()).permissionMode).toBe("default");
			if (done?.type !== "done") throw new Error("missing first turn");
			const switchedModel = { ...model, id: "auto", name: "Auto" };
			const second = runtime.stream(
				switchedModel,
				{
					systemPrompt: "Be useful",
					messages: [
						...context.messages,
						done.message,
						{ role: "user", content: "second turn", timestamp: Date.now() },
					],
				},
				{ sessionId: "pi-session", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			const switched = await runtime.snapshot();
			expect(switched.processes[0]).toMatchObject({
				generation: snapshot.processes[0]?.generation,
				modelId: "auto",
			});
		} finally {
			await runtime.close();
		}
	});

	it("restores a persisted ACP session across runtime restarts", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-runtime-session-"));
		const store = new AcpSessionStore(path.join(directory, "sessions.json"));
		const factory = (options: ConstructorParameters<typeof AntigravityAcpConnection>[0]) =>
			new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
		const firstRuntime = new AntigravityRuntime(factory, "yolo", store);
		try {
			const firstContext: Context = {
				messages: [{ role: "user", content: "first", timestamp: 1 }],
			};
			const first = firstRuntime.stream(model, firstContext, { sessionId: "persisted", apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const done = firstEvents.at(-1);
			if (done?.type !== "done") throw new Error("first turn did not complete");
			await firstRuntime.close();

			const secondRuntime = new AntigravityRuntime(factory, "yolo", store);
			try {
				const second = secondRuntime.stream(
					model,
					{
						messages: [
							...firstContext.messages,
							done.message,
							{ role: "user", content: "second", timestamp: 2 },
						],
					},
					{ sessionId: "persisted", apiKey: "test-key" },
				);
				for await (const _event of second.stream) void _event;
				expect((await secondRuntime.snapshot()).processes[0]?.restored).toBe(true);
			} finally {
				await secondRuntime.close();
			}
		} finally {
			await firstRuntime.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("recreates the ACP session when the owned Pi prefix changes", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const first = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "original", timestamp: 1 }] },
				{ sessionId: "rewind-session", apiKey: "test-key" },
			);
			for await (const _event of first.stream) void _event;
			const firstGeneration = (await runtime.snapshot()).processes[0]?.generation;

			const second = runtime.stream(
				model,
				{
					messages: [
						{ role: "user", content: "changed", timestamp: 1 },
						{ role: "user", content: "continue", timestamp: 2 },
					],
				},
				{ sessionId: "rewind-session", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			const secondGeneration = (await runtime.snapshot()).processes[0]?.generation;
			expect(secondGeneration).not.toBe(firstGeneration);
		} finally {
			await runtime.close();
		}
	});

	it("recreates a warm session when transcript instructions change", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		const firstContext = normalizeContext({
			systemPrompt: "Original instructions",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		try {
			const first = runtime.stream(model, firstContext, { sessionId: "system-delta", apiKey: "test-key" });
			for await (const _event of first.stream) void _event;
			const generation = (await runtime.snapshot()).processes[0]?.generation;
			const second = runtime.stream(model, normalizeContext({
				messages: [
					...firstContext.messages,
					first.message,
					{ role: "system", content: "Updated instructions", timestamp: 2 },
					{ role: "user", content: "continue", timestamp: 3 },
				],
			}), { sessionId: "system-delta", apiKey: "test-key" });
			for await (const _event of second.stream) void _event;
			expect(second.message.stopReason).toBe("stop");
			expect((await runtime.snapshot()).processes[0]?.generation).not.toBe(generation);
		} finally {
			await runtime.close();
		}
	});

	it("parks a permission request and resumes it from a Pi tool result", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const firstContext: Context = {
				messages: [{ role: "user", content: "request permission", timestamp: 1 }],
			};
			const firstWriter = runtime.stream(model, firstContext, {
				sessionId: "permission-session",
				apiKey: "test-key",
			});
			const firstEvents = [];
			for await (const event of firstWriter.stream) firstEvents.push(event);
			expect(firstEvents.map((event) => event.type)).toEqual([
				"start",
				"toolcall_start",
				"toolcall_delta",
				"toolcall_end",
				"done",
			]);
			const firstMessage = firstEvents.at(-1);
			if (firstMessage?.type !== "done") throw new Error("missing permission turn");
			const toolCall = firstMessage.message.content.find((block) => block.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall") throw new Error("missing permission tool call");
			const request = runtime.getPermission(toolCall.id);
			expect(request?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);

			const resumedContext: Context = {
				messages: [
					...firstContext.messages,
					firstMessage.message,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: PERMISSION_TOOL_NAME,
						content: [{ type: "text", text: "Rejected" }],
						details: {
							kind: PERMISSION_RESULT_KIND,
							requestId: toolCall.id,
							optionId: "reject-once",
							cancelled: false,
						},
						isError: false,
						timestamp: 2,
					},
				],
			};
			const secondWriter = runtime.stream(model, resumedContext, {
				sessionId: "permission-session",
				apiKey: "test-key",
			});
			const secondEvents = [];
			for await (const event of secondWriter.stream) secondEvents.push(event);
			expect(secondEvents.map((event) => event.type)).toEqual([
				"start",
				"text_start",
				"text_delta",
				"text_end",
				"done",
			]);
			expect(secondWriter.message.content).toEqual([{ type: "text", text: "Decision: selected" }]);
			expect(runtime.getPermission(toolCall.id)).toBeUndefined();
		} finally {
			await runtime.close();
		}
	});

	it("round-trips an MCP call through a genuine Pi tool call", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext = normalizeContext({
				messages: [{ role: "user", content: "use bridge", timestamp: 1 }],
				tools,
			});
			expect("tools" in firstContext).toBe(false);
			const firstWriter = runtime.stream(model, firstContext, { apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of firstWriter.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing bridged tool turn");
			expect(firstDone.reason).toBe("toolUse");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");
			expect(call).toMatchObject({ name: "echo", arguments: { text: "from gemini" } });

			const secondWriter = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "echo result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ apiKey: "test-key" },
			);
			const secondEvents = [];
			for await (const event of secondWriter.stream) secondEvents.push(event);
			expect(secondWriter.message.content).toEqual([{ type: "text", text: "echo result" }]);
			expect(secondEvents.at(-1)?.type).toBe("done");
		} finally {
			await runtime.close();
		}
	});

	it("sends images from a Pi tool result as a follow-up prompt instead of over MCP", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: "use bridge", timestamp: 1 }],
			};
			const firstWriter = runtime.stream(model, firstContext, { apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of firstWriter.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing bridged tool turn");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");

			const secondWriter = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [
								{ type: "text", text: "Read image file [image/png]" },
								{ type: "image", data: "aW1n", mimeType: "image/png" },
							],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ apiKey: "test-key" },
			);
			const secondEvents = [];
			for await (const event of secondWriter.stream) secondEvents.push(event);
			const text = secondWriter.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			// The MCP result carries the text and a note; the image arrives in the next prompt.
			expect(text).toContain("Read image file [image/png]\n[1 image(s) from this result cannot be shown in a tool result.");
			expect(text).toContain("saw image/png after: Image(s) returned by your echo tool call:\nContinue the task using these images.");
			expect(secondEvents.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		} finally {
			await runtime.close();
		}
	});

	it.each(["parallel", "parallel reversed"])("batches %s MCP calls into one Pi tool turn", async (scenario) => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: `use bridge ${scenario}`, timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, {
				sessionId: "parallel-session",
				apiKey: "test-key",
			});
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing parallel tool turn");
			const calls = firstDone.message.content.filter((block) => block.type === "toolCall");
			// Concurrent MCP clients may finish their handshakes in either order.
			expect(calls.map((call) => call.arguments.text).sort()).toEqual(["first", "second"]);

			const toolResults = calls.map((call, index) => ({
				role: "toolResult" as const,
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text" as const, text: `result-${call.arguments.text}` }],
				isError: false,
				timestamp: index + 2,
			}));
			const second = runtime.stream(
				model,
				{
					tools,
					messages: [...firstContext.messages, firstDone.message, ...toolResults],
				},
				{ sessionId: "parallel-session", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			expect(second.message.content).toEqual([{ type: "text", text: "result-first,result-second" }]);
		} finally {
			await runtime.close();
		}
	});

	it.each([
		// The ACP turn ends before Pi returns; the result opens a new prompt.
		{ scenario: "bridge timeout", wait: 500, shown: ["late echo result"] },
		// The ACP turn is still running; the result follows it in the same turn.
		{ scenario: "bridge timeout running", wait: 400, shown: ["gave up waiting", "late echo result"] },
	])("delivers a Pi tool result after Antigravity abandoned the MCP call: $scenario", async ({ scenario, wait, shown }) => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: `use ${scenario}`, timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, { sessionId: "late-result", apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing tool call turn");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing tool call");
			// The tool outlives Antigravity's MCP deadline (200 ms in the fake agent).
			await new Promise((resolve) => setTimeout(resolve, wait));

			const second = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "late echo result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ sessionId: "late-result", apiKey: "test-key" },
			);
			const secondEvents = [];
			for await (const event of second.stream) secondEvents.push(event);
			expect(secondEvents.at(-1)).toMatchObject({ type: "done", reason: "stop" });
			const text = second.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			for (const part of shown) expect(text).toContain(part);
		} finally {
			await runtime.close();
		}
	});

	it("hands a slow Pi tool off before Antigravity's MCP deadline", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
			"yolo",
			undefined,
			undefined,
			"pi",
			200,
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: "use bridge", timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, { sessionId: "handoff", apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing tool call turn");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing tool call");
			// Pi is still running the tool when the handoff ends the ACP turn.
			await new Promise((resolve) => setTimeout(resolve, 400));

			const second = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "slow echo result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ sessionId: "handoff", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			const text = second.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			// Delivered as a new prompt, not over the finished MCP request.
			expect(text).toContain("## Tool result (echo)\nslow echo result");
			expect(second.message.stopReason).toBe("stop");
		} finally {
			await runtime.close();
		}
	});

	it("honors cancellation on an MCP continuation stream", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: "use bridge delayed", timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, {
				sessionId: "continuation-abort",
				apiKey: "test-key",
			});
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing tool call turn");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing tool call");

			const controller = new AbortController();
			const second = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ sessionId: "continuation-abort", apiKey: "test-key", signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 30);
			const secondEvents = [];
			for await (const event of second.stream) secondEvents.push(event);
			expect(secondEvents.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			expect((await runtime.snapshot()).processes[0]?.alive).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("cancels an ACP prompt while preserving a healthy warm binding", async () => {
		let promptStarted!: () => void;
		const prompting = new Promise<void>((resolve) => { promptStarted = resolve; });
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
			const prompt = connection.prompt.bind(connection);
			connection.prompt = (...args) => { promptStarted(); return prompt(...args); };
			return connection;
		});
		try {
			const controller = new AbortController();
			const writer = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "hang", timestamp: 1 }] },
				{ sessionId: "abort-session", apiKey: "test-key", signal: controller.signal },
			);
			await prompting;
			controller.abort();
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			const snapshot = await runtime.snapshot();
			expect(snapshot.bindings).toBe(1);
			expect(snapshot.processes[0]?.alive).toBe(true);
		} finally {
			await runtime.close();
		}
	});
});
