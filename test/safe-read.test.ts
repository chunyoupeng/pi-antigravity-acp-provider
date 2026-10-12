import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSafeReadToolDefinition } from "../extensions/safe-read.js";
import { PiMcpBridge } from "../src/mcp/bridge.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(content: string | Buffer, name = "file.txt") {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-safe-read-"));
	directories.push(cwd);
	const file = path.join(cwd, name);
	fs.writeFileSync(file, content);
	const tool = createSafeReadToolDefinition(cwd);
	type ReadContext = Parameters<typeof tool.execute>[4];
	const ctx = { cwd, model: { provider: "antigravity-acp", input: ["text", "image"] } } as ReadContext;
	return {
		cwd, file, tool, ctx,
		read: (params: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
			tool.execute("read-test", { path: name, ...params }, signal, undefined, ctx),
	};
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof createSafeReadToolDefinition>["execute"]>>) {
	const block = result.content[0];
	if (block?.type !== "text") throw new Error("Expected a text result");
	expect(result.structuredContent).toBe(block.text);
	return block.text;
}

describe("Antigravity safe read", () => {
	it.each([0, 1, 4095, 4096])("returns a %i-byte file unchanged", async (bytes) => {
		const f = fixture("a".repeat(bytes));
		const result = await f.read();
		expect(textOf(result)).toBe("a".repeat(bytes));
		expect(result.details).toBeUndefined();
	});

	it("returns accurate full-file metadata and a bounded preview for large files", async () => {
		const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"x".repeat(96)}`);
		const content = lines.join("\n");
		const f = fixture(content);
		const result = await f.read();
		const text = textOf(result);
		expect(text).toContain(`[File: ${f.file} | Total: 250 lines, ${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB]`);
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
		const body = text.split("\n").slice(1, -2).join("\n");
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3072);
		expect(Buffer.byteLength(body)).toBeGreaterThan(2900);
		expect(body).toBe(lines.slice(0, body.split("\n").length).join("\n"));
	});

	it("reads every line once via the advertised offsets, including a trailing newline", async () => {
		const content = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"x".repeat(96)}`).join("\n") + "\n";
		const f = fixture(content);
		const pages: string[] = [];
		let offset = 1;
		for (let page = 0; page < 20; page++) {
			const text = textOf(await f.read({ offset }));
			expect(text).toContain("Total: 251 lines");
			expect(Buffer.byteLength(text)).toBeLessThan(4096);
			const match = /\n\.\.\.\n\[\d+ lines remaining\. If more content is needed, use offset=(\d+) to continue\.\]$/u.exec(text);
			const body = text.slice(text.indexOf("\n") + 1, match?.index);
			pages.push(body);
			if (!match) break;
			const next = Number(match[1]);
			expect(next).toBeGreaterThan(offset);
			offset = next;
		}
		expect(pages.join("\n")).toBe(content);
	});

	it("honors offset and limit even when the requested page is small", async () => {
		const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"x".repeat(96)}`);
		const f = fixture(lines.join("\n"));
		const text = textOf(await f.read({ offset: 81, limit: 2 }));
		expect(text.split("\n").slice(1, -2).join("\n")).toBe(lines.slice(80, 82).join("\n"));
		expect(text).toContain("168 lines remaining. If more content is needed, use offset=83 to continue.");
		const last = textOf(await f.read({ offset: 250 }));
		expect(last.endsWith(lines[249]!)).toBe(true);
		expect(last).not.toContain("offset=");
		const empty = textOf(await f.read({ offset: 81, limit: 0 }));
		expect(empty).toContain("If more content is needed, use offset=81 to continue.");
	});

	it("counts UTF-8 bytes and never splits Chinese characters or emoji", async () => {
		const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"中文🙂".repeat(10)}`);
		const content = lines.join("\n");
		const f = fixture(content);
		const text = textOf(await f.read());
		expect(text).toContain(`${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB`);
		expect(text).not.toContain("�");
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
	});

	it("shows a bounded prefix for an oversized single line without a false next-line offset", async () => {
		const f = fixture("🙂".repeat(2000));
		const text = textOf(await f.read());
		expect(text).toContain("Total: 1 lines, 7.8 KiB");
		expect(text).toContain("only its prefix is shown");
		expect(text).not.toContain("offset=");
		expect(text).not.toContain("�");
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
	});

	it("retains full-file totals beyond Pi's own 50 KiB truncation", async () => {
		const f = fixture(Array.from({ length: 250 }, () => "x".repeat(1000)).join("\n"));
		const text = textOf(await f.read());
		expect(text).toContain("Total: 250 lines, 244.4 KiB");
		expect(text).toContain("247 lines remaining. If more content is needed, use offset=4 to continue.");
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
	});

	it("keeps the original reader for other providers", async () => {
		const f = fixture("a".repeat(6000));
		const ctx = { ...f.ctx, model: { ...f.ctx.model!, provider: "other" } };
		const result = await f.tool.execute("read-test", { path: f.file }, undefined, undefined, ctx);
		expect(textOf(result)).toBe("a".repeat(6000));
	});

	it("preserves images and their original structured output", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
		const f = fixture(png, "image.png");
		const result = await f.read();
		const original = await createReadToolDefinition(f.cwd).execute("read-test", { path: f.file }, undefined, undefined, f.ctx);
		expect(result).toEqual(original);
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	it("preserves failed-image notes even when the image exceeds 4 KiB", async () => {
		const brokenPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
		const f = fixture(Buffer.concat([brokenPng, Buffer.alloc(6000)]), "broken.png");
		const result = await f.read();
		const original = await createReadToolDefinition(f.cwd).execute("read-test", { path: f.file }, undefined, undefined, f.ctx);
		expect(result).toEqual(original);
		expect(result.content.some((block) => block.type === "image")).toBe(false);
		expect(textOf(result)).toContain("Read image file");
	});

	it("preserves errors and cancellation from the original reader", async () => {
		const f = fixture("one\ntwo");
		await expect(f.read({ offset: 3 })).rejects.toThrow("beyond end of file");
		await expect(f.tool.execute("read-test", { path: "missing.txt" }, undefined, undefined, f.ctx)).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(f.read({}, controller.signal)).rejects.toThrow("Operation aborted");
	});

	it("sends the bounded preview, not the full file, through the MCP bridge", async () => {
		const f = fixture(Array.from({ length: 250 }, (_, i) => `${i}: ${"x".repeat(100)}`).join("\n"));
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
			expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThan(4096);
		} finally {
			await client.close();
			await bridge.close();
		}
	});
});
