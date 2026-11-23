import type { Message, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

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
	contextWindow: 512_000,
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
		chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)), { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe.skipIf(!enabled)("authenticated Google Antigravity ACP CLI", () => {
	it("creates a session and completes a harmless prompt", async () => {
		const updates: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(),
			dangerouslySkipPermissions: true,
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
			expect(initialize.agentInfo?.name).toBe("Antigravity ACP Server");
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

	it("reads a 30 KB text file with native read_file", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-read-"));
		const marker = randomUUID();
		const filler = Array.from({ length: 400 }, (_, index) => `filler line ${index}: ${"x".repeat(60)}`);
		const textPath = path.join(cwd, "large.txt");
		fs.writeFileSync(textPath, [...filler, `LIVE_MARKER=${marker}`, ""].join("\n"));
		const messages: Message[] = [
			{
				role: "user",
				content:
					`Read ${textPath} in full using read_file. ` +
					"Reply with exactly: MARKER=<the value after LIVE_MARKER= on the last line>",
				timestamp: 1,
			},
		];
		const runtime = new AntigravityRuntime(undefined, "yolo");
		try {
			const writer = runtime.stream(model, { messages }, { apiKey: MANAGED_AUTH_MARKER });
			for await (const _event of writer.stream) void _event;
			const reply = writer.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			expect(reply).toContain(`MARKER=${marker}`);
		} finally {
			await runtime.close();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 300_000);

	it("sees an image sent as a prompt block", async () => {
		const messages: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(),
			dangerouslySkipPermissions: true,
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

	it("discovers thinking levels and switches between them", async () => {
		const runtime = new AntigravityRuntime(undefined, "yolo");
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
