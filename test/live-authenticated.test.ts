import type { Message, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { createSafeReadToolDefinition } from "../extensions/safe-read.js";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { projectModels } from "../src/models.js";
import { AntigravityRuntime, MANAGED_AUTH_MARKER } from "../src/runtime.js";

const enabled = process.env.PI_ANTIGRAVITY_ACP_LIVE === "1";
const model: Model<"antigravity-acp"> = {
	id: "gemini-3.8-flash",
	name: "Gemini 3.8 Flash",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function solidPng(size: number, rgb: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from(rgb))]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		// Stored, not compressed, so a 64px image exceeds the 4 KiB MCP default.
		chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)), { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe.skipIf(!enabled)("authenticated Google Antigravity ACP server", () => {
	it("creates a session and completes a harmless prompt", async () => {
		const updates: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(),
			operationTimeoutMs: 120_000,
			handlers: {
				onUpdate: (notification) => {
					const update = notification.update;
					if (
						(update.sessionUpdate === "agent_message_chunk" ||
							update.sessionUpdate === "agent_thought_chunk") &&
						update.content.type === "text"
					) {
						updates.push(update.content.text);
					}
				},
				onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			},
		});
		try {
			const initialize = await connection.initialize();
			expect(initialize.agentInfo?.name).toBe("antigravity-acp");
			const session = await connection.newSession(process.cwd());
			expect(session.sessionId).toBeTruthy();
			const response = await connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "Reply with exactly: ANTIGRAVITY_ACP_LIVE_OK" }],
			});
			expect(response.stopReason).toBe("end_turn");
			expect(updates.join("")).toContain("ANTIGRAVITY_ACP_LIVE_OK");
		} finally {
			await connection.close();
		}
	}, 180_000);

	// A Pi read result past the old 4 KiB MCP threshold reaches the model inline
	// once mcpMaxOutputBytes is raised; native view_file is disabled.
	it("reads a 30 KB text file with one Pi read call", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-read-"));
		const marker = randomUUID();
		const filler = Array.from({ length: 400 }, (_, index) => `filler line ${index}: ${"x".repeat(60)}`);
		const textPath = path.join(cwd, "large.txt");
		fs.writeFileSync(textPath, [...filler, `LIVE_MARKER=${marker}`, ""].join("\n"));
		const read = createSafeReadToolDefinition(cwd);
		type ReadContext = Parameters<typeof read.execute>[4];
		const tools = [{ name: read.name, description: read.description, parameters: read.parameters }];
		const messages: Message[] = [
			{
				role: "user",
				content:
					`Read ${textPath} in full. Do not use subagents or commands. ` +
					"Reply with exactly: MARKER=<the value after LIVE_MARKER= on the last line>",
				timestamp: 1,
			},
		];
		const runtime = new AntigravityRuntime(undefined, "yolo", undefined, undefined, "pi");
		const transcript: string[] = [];
		try {
			for (let turn = 0; turn < 6; turn++) {
				const writer = runtime.stream(model, { tools, messages }, { apiKey: MANAGED_AUTH_MARKER });
				for await (const _event of writer.stream) void _event;
				const message = writer.message;
				messages.push(message);
				transcript.push(JSON.stringify(message.content));
				if (message.stopReason !== "toolUse") break;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const result = await read.execute(block.id, block.arguments as { path: string }, undefined, undefined, { cwd, model } as unknown as ReadContext);
					messages.push({ role: "toolResult", toolCallId: block.id, toolName: block.name, content: result.content, isError: false, timestamp: messages.length + 1 });
				}
			}
			const reads = messages.flatMap((message) =>
				message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
			);
			const last = messages.at(-1);
			const reply = last?.role === "assistant" ? last.content.map((block) => (block.type === "text" ? block.text : "")).join("") : "";
			expect(reads, transcript.join("\n")).toHaveLength(1);
			expect(reply, transcript.join("\n")).toContain(`MARKER=${marker}`);
		} finally {
			await runtime.close();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 300_000);

	// The image exists only in the prompt, so a tool or subagent cannot
	// substitute for the model seeing it.
	it("sees an image sent as a prompt block", async () => {
		const messages: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(),
			operationTimeoutMs: 120_000,
			handlers: {
				onUpdate: (notification) => {
					const update = notification.update;
					if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
						messages.push(update.content.text);
					}
				},
				onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			},
		});
		try {
			const initialize = await connection.initialize();
			expect(initialize.agentCapabilities?.promptCapabilities?.image).toBe(true);
			const session = await connection.newSession(process.cwd());
			const response = await connection.prompt({
				sessionId: session.sessionId,
				prompt: [
					{ type: "image", data: solidPng(64, [255, 0, 0]).toString("base64"), mimeType: "image/png" },
					{ type: "text", text: "Without using any tools, reply with exactly: COLOR=<the single color filling this image>" },
				],
			});
			expect(response.stopReason).toBe("end_turn");
			expect(messages.join("")).toMatch(/COLOR=\s*red/iu);
		} finally {
			await connection.close();
		}
	}, 180_000);

	// The image exists only in the Pi tool result, so the model can answer only
	// if the provider delivers it as a follow-up prompt.
	it("sees an image returned by a bridged Pi tool", async () => {
		const imagePath = "/virtual/swatch.png";
		const tools = [
			{
				name: "read",
				description: "Read a file. Supports text and images (png, jpg); images are returned as attachments.",
				parameters: Type.Object({ path: Type.String() }),
			},
		];
		const messages: Message[] = [
			{
				role: "user",
				content:
					`Use the read tool on ${imagePath}. It exists only through that tool. ` +
					"Then reply with exactly: COLOR=<the single color filling the image>",
				timestamp: 1,
			},
		];
		const runtime = new AntigravityRuntime(undefined, "yolo", undefined, undefined, "pi");
		const transcript: string[] = [];
		try {
			for (let turn = 0; turn < 6; turn++) {
				const writer = runtime.stream(model, { tools, messages }, { apiKey: MANAGED_AUTH_MARKER });
				for await (const _event of writer.stream) void _event;
				const message = writer.message;
				messages.push(message);
				transcript.push(JSON.stringify(message.content));
				if (message.stopReason !== "toolUse") break;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const isImage = block.name === "read" && block.arguments.path === imagePath;
					messages.push({
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: isImage
							? [
									{ type: "text", text: "Read image file [image/png]" },
									{ type: "image", data: solidPng(64, [0, 160, 0]).toString("base64"), mimeType: "image/png" },
								]
							: [{ type: "text", text: "Not available in this test" }],
						isError: !isImage,
						timestamp: messages.length + 1,
					});
				}
			}
			const last = messages.at(-1);
			const reply =
				last?.role === "assistant"
					? last.content.map((block) => (block.type === "text" ? block.text : "")).join("")
					: "";
			expect(last?.role === "assistant" ? last.stopReason : undefined, transcript.join("\n")).toBe("stop");
			expect(reply, transcript.join("\n")).toMatch(/COLOR=\s*green/iu);
		} finally {
			await runtime.close();
		}
	}, 300_000);

	// Antigravity 1.4 folds thinking-level variants into a model family plus a
	// thought_level selector; each level must be selected and confirmed.
	it("discovers thinking levels and switches between them", async () => {
		const runtime = new AntigravityRuntime(undefined, "yolo", undefined, undefined, "pi");
		try {
			const models = projectModels(await runtime.discoverModels(MANAGED_AUTH_MARKER));
			const family = models.find((candidate) => candidate.thinkingLevelMap?.low && candidate.thinkingLevelMap.high);
			expect(family, JSON.stringify(models)).toBeDefined();
			for (const reasoning of ["low", "high"] as const) {
				const writer = runtime.stream(
					family!,
					{ messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 1 }] },
					{ apiKey: MANAGED_AUTH_MARKER, reasoning },
				);
				for await (const _event of writer.stream) void _event;
				expect(writer.message.stopReason, JSON.stringify(writer.message)).toBe("stop");
				expect(writer.message.responseModel).toBe(family!.thinkingLevelMap![reasoning]);
			}
		} finally {
			await runtime.close();
		}
	}, 300_000);
});
