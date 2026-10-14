import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
	createSafeBashToolDefinition,
	createSafeReadToolDefinition,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIMENSION,
	MAX_TEXT_RESULT_BYTES,
} from "../extensions/safe-read.js";
import { PiMcpBridge } from "../src/mcp/bridge.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-safe-read-"));
	directories.push(directory);
	return directory;
}

function fixture(content: string | Buffer, name = "file.txt") {
	const cwd = tempDir();
	const file = path.join(cwd, name);
	fs.writeFileSync(file, content);
	const tool = createSafeReadToolDefinition(cwd);
	type ReadContext = Parameters<typeof tool.execute>[4];
	const ctx = { cwd, model: { provider: "antigravity-acp", input: ["text", "image"] } } as ReadContext;
	return {
		cwd, file, tool, ctx,
		read: (params: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
			tool.execute("read-test", { path: file, ...params }, signal, undefined, ctx),
	};
}

const englishLines = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}: ${"x".repeat(96)}`);
const chineseLines = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}: ${"支付需求开发礼金有效期".repeat(4)}`);

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
	const block = result.content[0];
	if (block?.type !== "text" || typeof block.text !== "string") throw new Error("Expected a text result");
	return block.text;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("Antigravity safe read", () => {
	it("returns a file up to the inline limit unchanged", async () => {
		const content = englishLines(400).join("\n");
		expect(bytes(content)).toBeLessThan(MAX_TEXT_RESULT_BYTES);
		const result = await (fixture(content)).read();
		expect(textOf(result)).toBe(content);
		expect(result.details).toBeUndefined();
	});

	it.each([
		["English", englishLines(1500)],
		["Chinese", chineseLines(1500)],
	])("pages a large %s file within the inline limit and rebuilds it from the offsets", async (_label, lines) => {
		const content = `${lines.join("\n")}\n`;
		expect(bytes(content)).toBeGreaterThan(100 * 1024);
		const f = fixture(content);
		const collected: string[] = [];
		let offset: number | undefined;
		for (let page = 0; page < 10; page++) {
			const text = textOf(await f.read(offset === undefined ? {} : { offset }));
			expect(bytes(text)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
			expect(text).not.toContain("�");
			const note = /\n\n\[Showing lines (\d+)-(\d+) of (\d+) \(45\.0KB limit\)\. Use offset=(\d+) to continue\.\]$/u.exec(text);
			if (!note) {
				collected.push(text);
				break;
			}
			expect(Number(note[1])).toBe(offset ?? 1);
			expect(Number(note[3])).toBe(lines.length + 1);
			collected.push(text.slice(0, note.index));
			offset = Number(note[4]);
		}
		expect(collected.join("\n")).toBe(content);
	});

	it("keeps a requested range and says where the file continues", async () => {
		const lines = englishLines(1500);
		const f = fixture(lines.join("\n"));
		expect(textOf(await f.read({ offset: 10, limit: 3 }))).toBe(
			`${lines.slice(9, 12).join("\n")}\n\n[1488 more lines in file. Use offset=13 to continue.]`,
		);
		const text = textOf(await f.read({ offset: 101, limit: 1000 }));
		expect(bytes(text)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		expect(text).toMatch(/^101: x+\n/u);
		expect(text).toMatch(/\n\n\[Showing lines 101-\d+ of 1500 \(45\.0KB limit\)\. Use offset=\d+ to continue\.\]$/u);
	});

	it("points a line over the page size at pi_bash", async () => {
		const f = fixture("a".repeat(48 * 1024));
		expect(textOf(await f.read())).toBe(
			`[Line 1 is 48.0KB, exceeds 45.0KB limit. Use pi_bash: sed -n '1p' ${f.file} | head -c 46080]`,
		);
	});

	it("keeps the original reader for other providers", async () => {
		const content = englishLines(1500).join("\n");
		const f = fixture(content);
		const ctx = { ...f.ctx, model: { ...f.ctx.model!, provider: "other" } };
		const result = await f.tool.execute("read-test", { path: f.file }, undefined, undefined, ctx);
		const original = await createReadToolDefinition(f.cwd).execute("read-test", { path: f.file }, undefined, undefined, ctx);
		expect(result).toEqual(original);
		expect(bytes(textOf(result))).toBeGreaterThan(MAX_TEXT_RESULT_BYTES);
	});

	it("preserves small images and compresses oversized images below 512 KiB and 1536px", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
		const f = fixture(png, "image.png");
		const result = await f.read();
		const original = await createReadToolDefinition(f.cwd).execute("read-test", { path: f.file }, undefined, undefined, f.ctx);
		expect(result).toEqual(original);
		expect(result.content.some((block) => block.type === "image")).toBe(true);

		const width = 1800;
		const height = 1200;
		const raw = Buffer.alloc((width * 3 + 1) * height);
		for (let y = 0; y < height; y++) {
			raw[y * (width * 3 + 1)] = 0;
			for (let x = 0; x < width * 3; x++) {
				raw[y * (width * 3 + 1) + 1 + x] = (x * 31 + y * 17 + (x ^ y)) & 0xff;
			}
		}
		const chunk = (type: string, data: Buffer) => {
			const len = Buffer.alloc(4);
			len.writeUInt32BE(data.length);
			const body = Buffer.concat([Buffer.from(type), data]);
			const crc = Buffer.alloc(4);
			crc.writeUInt32BE(zlib.crc32(body) >>> 0);
			return Buffer.concat([len, body, crc]);
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(width, 0);
		ihdr.writeUInt32BE(height, 4);
		ihdr[8] = 8;
		ihdr[9] = 2;
		const largePng = Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", ihdr),
			chunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(largePng.byteLength).toBeGreaterThan(2 * MAX_IMAGE_BYTES);
		const compressed = await fixture(largePng, "large.png").read();
		const textBlock = compressed.content.find((block) => block.type === "text");
		const imageBlock = compressed.content.find((block) => block.type === "image");
		expect(textBlock?.type).toBe("text");
		if (textBlock?.type === "text") {
			expect(textBlock.text).toContain(`original ${width}x${height}`);
			const displayed = /displayed at (\d+)x(\d+)/u.exec(textBlock.text);
			expect(Number(displayed?.[1])).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
			expect(Number(displayed?.[2])).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
		}
		expect(imageBlock?.type).toBe("image");
		if (imageBlock?.type === "image") {
			expect(Buffer.byteLength(imageBlock.data, "utf8")).toBeLessThan(MAX_IMAGE_BYTES);
		}
	});

	it("preserves errors and cancellation from the original reader", async () => {
		const f = fixture("一\n二");
		await expect(f.read({ offset: 3 })).rejects.toThrow("beyond end of file");
		await expect(f.tool.execute("read-test", { path: "missing.txt" }, undefined, undefined, f.ctx)).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(f.read({}, controller.signal)).rejects.toThrow("Operation aborted");
	});

	it("sends a bounded page through the MCP bridge unchanged", async () => {
		const f = fixture(chineseLines(1500).join("\n"));
		const bridge = new PiMcpBridge({
			tools: [f.tool],
			onCall: async (invocation) => {
				const result = await f.read(invocation.arguments);
				return { content: result.content };
			},
		});
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("Bridge did not start");
		const client = new Client({ name: "safe-read-test", version: "1" }, { capabilities: {} });
		try {
			const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
				requestInit: { headers: Object.fromEntries(descriptor.headers.map((h) => [h.name, h.value])) },
			});
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const result = await client.callTool({ name: "pi_read", arguments: { path: f.file } });
			expect(result.content).toEqual((await f.read()).content);
			expect(bytes(textOf(result as { content: Array<{ type: string; text?: string }> }))).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		} finally {
			await client.close();
			await bridge.close();
		}
	});
});

function bashFixture(output: string | Buffer, exitCode: number | "timeout" = 0) {
	const cwd = tempDir();
	const data = typeof output === "string" ? Buffer.from(output, "utf8") : output;
	const tool = createSafeBashToolDefinition(cwd, {
		operations: {
			exec: async (_command: string, _execCwd: string, { onData, signal }: { onData: (data: Buffer) => void; signal?: AbortSignal }) => {
				if (signal?.aborted) throw new Error("aborted");
				if (data.byteLength > 0) onData(data);
				if (exitCode === "timeout") throw new Error("timeout:3");
				return { exitCode };
			},
		},
	});
	type BashContext = Parameters<typeof tool.execute>[4];
	const ctx = {
		cwd,
		model: { id: "gemini-4-argon", provider: "antigravity-acp", input: ["text", "image"] },
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined },
	} as unknown as BashContext;
	return {
		tool,
		ctx,
		run: (command = "echo test", signal?: AbortSignal) => tool.execute("bash-test", { command }, signal, undefined, ctx),
	};
}

/** The tail note's line range and saved file. */
function tailNote(text: string) {
	const note = /\n\n\[Showing lines (\d+)-(\d+) of (\d+) \(45\.0KB limit\)\. Full output: ([^\n]+)\]/u.exec(text);
	if (!note) throw new Error(`Missing tail note in: ${text.slice(-300)}`);
	return { start: Number(note[1]), end: Number(note[2]), total: Number(note[3]), file: note[4]!, index: note.index };
}

describe("Antigravity safe bash", () => {
	it("returns output up to the inline limit unchanged", async () => {
		const content = englishLines(400).join("\n");
		const result = await bashFixture(content).run();
		expect(textOf(result)).toBe(content);
		expect(result.details).toBeUndefined();
	});

	it("keeps the tail of output between the inline limit and Pi's 50 KiB and saves all of it", async () => {
		const lines = englishLines(480);
		const content = lines.join("\n");
		expect(bytes(content)).toBeGreaterThan(MAX_TEXT_RESULT_BYTES);
		expect(bytes(content)).toBeLessThan(50 * 1024);
		const text = textOf(await bashFixture(content).run("rg something"));
		expect(bytes(text)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		const note = tailNote(text);
		expect(note.end).toBe(480);
		expect(note.total).toBe(480);
		expect(text.slice(0, note.index)).toBe(lines.slice(note.start - 1).join("\n"));
		expect(fs.readFileSync(note.file, "utf8")).toBe(content);
		fs.rmSync(note.file, { force: true });
	});

	it("reuses Pi's full output file when Pi already truncated", async () => {
		const lines = englishLines(1200);
		const content = lines.join("\n");
		const text = textOf(await bashFixture(content).run("find ."));
		expect(bytes(text)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		const note = tailNote(text);
		expect(note.total).toBe(1200);
		expect(text.slice(0, note.index)).toBe(lines.slice(note.start - 1).join("\n"));
		expect(fs.readFileSync(note.file, "utf8")).toBe(content);
	});

	it("keeps a non-zero exit status after the tail", async () => {
		const result = await bashFixture(englishLines(1200).join("\n"), 2).run("npm test");
		const text = textOf(result);
		expect(result.isError).toBe(true);
		expect(bytes(text)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		expect(tailNote(text).total).toBe(1200);
		expect(text.endsWith("\n\nCommand exited with code 2")).toBe(true);
	});

	it("bounds a timed-out command error and keeps its status", async () => {
		const content = englishLines(480).join("\n");
		let thrown: Error | undefined;
		try {
			await bashFixture(content, "timeout").run("sleep 10");
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(bytes(thrown!.message)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		expect(thrown!.message.endsWith("\n\nCommand timed out after 3 seconds")).toBe(true);
		const note = tailNote(thrown!.message);
		expect(fs.readFileSync(note.file, "utf8")).toBe(content);
		fs.rmSync(note.file, { force: true });
	});

	it("shows the end of a single oversized line without invalid UTF-8", async () => {
		const text = textOf(await bashFixture("中".repeat(20_000)).run("echo single-line"));
		expect(bytes(text)).toBeLessThanOrEqual(MAX_TEXT_RESULT_BYTES);
		expect(text).toMatch(/\n\n\[Showing last [\d.]+KB of line 1\. Full output: [^\n]+\]$/u);
		expect(text).not.toContain("�");
	});

	it("keeps the original bash behavior for other providers", async () => {
		const content = englishLines(480).join("\n");
		const f = bashFixture(content);
		const ctx = { ...f.ctx, model: { ...f.ctx.model!, provider: "other" } };
		expect(textOf(await f.tool.execute("bash-test", { command: "echo hi" }, undefined, undefined, ctx))).toBe(content);
	});
});
