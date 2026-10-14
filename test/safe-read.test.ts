import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHINESE_RATIO_THRESHOLD, chineseRatio, createSafeReadToolDefinition, STAGE_DIRECTORY_NAME } from "../extensions/safe-read.js";
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

/** `location` places the file in the session workspace (default), in App Data
 * Directory, or outside both (where view_file cannot read it). */
function fixture(content: string | Buffer, name = "file.txt", location: "workspace" | "appData" | "outside" = "workspace") {
	const cwd = tempDir();
	const appData = tempDir();
	const directory = location === "workspace" ? cwd : location === "appData" ? appData : tempDir();
	const file = path.join(directory, name);
	fs.writeFileSync(file, content);
	const tool = createSafeReadToolDefinition(cwd, appData);
	type ReadContext = Parameters<typeof tool.execute>[4];
	const ctx = { cwd, model: { provider: "antigravity-acp", input: ["text", "image"] } } as ReadContext;
	return {
		cwd, appData, file, tool, ctx,
		read: (params: { offset?: number; limit?: number } = {}, signal?: AbortSignal) =>
			tool.execute("read-test", { path: file, ...params }, signal, undefined, ctx),
	};
}

const englishLines = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}: ${"x".repeat(96)}`);

function textOf(result: Awaited<ReturnType<ReturnType<typeof createSafeReadToolDefinition>["execute"]>>) {
	const block = result.content[0];
	if (block?.type !== "text") throw new Error("Expected a text result");
	expect(result.structuredContent).toBe(block.text);
	return block.text;
}

describe("Antigravity hybrid safe read", () => {
	it.each([0, 1, 4095, 4096])("returns a %i-byte file unchanged", async (bytes) => {
		const f = fixture("a".repeat(bytes));
		const result = await f.read();
		expect(textOf(result)).toBe("a".repeat(bytes));
		expect(result.details).toBeUndefined();
	});

	it("copies large non-Chinese files outside the whitelist into App Data Directory with a summary and preview", async () => {
		const content = `${Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const f = fixture(content, "en-test.txt", "outside");
		const result = await f.read();
		const text = textOf(result);
		const staged = /pi_read copied the complete file to (.+?)\. Preview/u.exec(text)?.[1];
		expect(staged).toBeDefined();
		expect(path.dirname(staged!)).toBe(path.join(f.appData, STAGE_DIRECTORY_NAME));
		expect(path.basename(staged!)).toMatch(/^[0-9a-f]{16}-en-test\.txt$/u);
		expect(fs.readFileSync(staged!, "utf8")).toBe(content);
		const [header, summary, ...rest] = text.split("\n");
		expect(header).toBe(`[File: ${f.file} | Total: 3001 lines, ${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB]`);
		expect(summary).toContain("[Summary: Non-Chinese text (0.0% Chinese characters, below 10%). It is outside Active Workspaces, so view_file cannot open it;");
		expect(summary).toContain("If the preview is enough, stop here; otherwise use view_file as described at the end instead of paging pi_read.]");
		const shown = Number(/Preview: lines 1-(\d+) below/u.exec(summary!)?.[1]);
		expect(rest.slice(0, shown).join("\n")).toBe(content.split("\n").slice(0, shown).join("\n"));
		expect(shown).toBeGreaterThan(300);
		expect(text.endsWith(`[Lines ${shown + 1}-3001 are not shown. Read them with one view_file call (AbsolutePath: ${staged}, StartLine=${shown + 1}). That path is a complete copy of ${f.file}; line numbers match. Edit the original path, not the copy.]`)).toBe(true);
		expect(result.details).toBeUndefined();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);

		// Re-reading an unchanged file reuses the copy; a range is carried to view_file.
		const ranged = textOf(await f.read({ offset: 2001, limit: 500 }));
		expect(ranged).toContain("Preview: lines 2001-");
		expect(ranged).toMatch(new RegExp(`Read them with one view_file call \\(AbsolutePath: ${staged!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}, StartLine=\\d+, EndLine=2500\\)`, "u"));
		expect(fs.readdirSync(path.dirname(staged!))).toEqual([path.basename(staged!)]);

		// An edited file gets a fresh copy with its new content.
		fs.appendFileSync(f.file, "line 3001\n");
		const fresh = /pi_read copied the complete file to (.+?)\. Preview/u.exec(textOf(await f.read()))?.[1];
		expect(fresh).not.toBe(staged);
		expect(fs.readFileSync(fresh!, "utf8").endsWith("line 3001\n")).toBe(true);
	});

	it("prunes staged copies unused for 7 days", async () => {
		const f = fixture(englishLines(250).join("\n"), "file.txt", "outside");
		const directory = path.join(f.appData, STAGE_DIRECTORY_NAME);
		fs.mkdirSync(directory, { recursive: true });
		const stale = path.join(directory, "stale.txt");
		const recent = path.join(directory, "recent.txt");
		fs.writeFileSync(stale, "old");
		fs.writeFileSync(recent, "new");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(stale, old, old);
		await f.read();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(recent)).toBe(true);
	});

	it.each(["workspace", "appData"] as const)("gives large non-Chinese files in %s a summary, a preview and one view_file call for the rest", async (location) => {
		const lines = englishLines(250);
		const f = fixture(lines.join("\n"), "Service.java", location);
		const result = await f.read();
		const text = textOf(result);
		const [header, summary, ...rest] = text.split("\n");
		expect(header).toBe(`[File: ${f.file} | Total: 250 lines, ${(Buffer.byteLength(lines.join("\n")) / 1024).toFixed(1)} KiB]`);
		expect(summary).toMatch(/^\[Summary: Non-Chinese text \(0\.0% Chinese characters, below 10%\)\. Preview: lines 1-\d+ below\. If the preview is enough, stop here; otherwise use view_file as described at the end instead of paging pi_read\.\]$/u);
		const shown = Number(/Preview: lines 1-(\d+)/u.exec(summary!)?.[1]);
		expect(shown).toBeGreaterThan(20);
		expect(rest.slice(0, shown)).toEqual(lines.slice(0, shown));
		expect(text.endsWith(`\n...\n[Lines ${shown + 1}-250 are not shown. Read them with one view_file call (AbsolutePath: ${f.file}, StartLine=${shown + 1}).]`)).toBe(true);
		expect(text).not.toContain("offset=");
		expect(text).not.toContain("copy");
		expect(result.details).toBeUndefined();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
	});

	it("previews a requested non-Chinese range and continues it with view_file", async () => {
		const lines = englishLines(250);
		const f = fixture(lines.join("\n"));
		const small = textOf(await f.read({ offset: 81, limit: 5 }));
		expect(small).toContain("Preview: lines 81-85 below");
		expect(small.split("\n").slice(2, 7)).toEqual(lines.slice(80, 85));
		expect(small.endsWith(`[165 more lines in file after line 85. If needed, read them with view_file (AbsolutePath: ${f.file}, StartLine=86).]`)).toBe(true);
		const large = textOf(await f.read({ offset: 81, limit: 100 }));
		const shownEnd = Number(/Preview: lines 81-(\d+)/u.exec(large)?.[1]);
		expect(large.endsWith(`[Lines ${shownEnd + 1}-180 are not shown. Read them with one view_file call (AbsolutePath: ${f.file}, StartLine=${shownEnd + 1}, EndLine=180).]`)).toBe(true);
		const tail = textOf(await f.read({ offset: 240 }));
		expect(tail).toContain("Preview: lines 240-250 below");
		expect(tail).not.toContain("view_file (AbsolutePath");
	});

	it("keeps the whole result inline when a long path inflates the summary and footer", async () => {
		const name = `${"deep-directory-name-".repeat(10)}.txt`;
		const f = fixture(englishLines(250).join("\n"), name, "outside");
		const text = textOf(await f.read());
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
		expect(text).toContain("Preview: lines 1-");
	});

	it("treats code with a few Chinese comments as non-Chinese (below 10% Han characters)", async () => {
		const lines = englishLines(250);
		for (let i = 0; i < lines.length; i += 25) lines[i] = `// 礼金有效期校验 ${lines[i]}`;
		const f = fixture(lines.join("\n"), "GiftPayService.java");
		const text = textOf(await f.read());
		expect(chineseRatio(lines.join("\n"))).toBeLessThan(CHINESE_RATIO_THRESHOLD);
		expect(text).toContain("[Summary: Non-Chinese text");
		expect(text).toContain("Read them with one view_file call");
		expect(text).not.toContain("parallel page offsets");
	});

	it("paginates Chinese-heavy files in the workspace too", async () => {
		const f = fixture(Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"支付需求开发礼金有效期".repeat(3)}`).join("\n"), "需求.md");
		const text = textOf(await f.read());
		expect(text).toContain("parallel page offsets:");
		expect(text).not.toContain("view_file");
	});

	it("measures the Chinese ratio over non-whitespace characters", () => {
		expect(chineseRatio("")).toBe(0);
		expect(chineseRatio("   \n\t")).toBe(0);
		expect(chineseRatio("中文")).toBe(1);
		expect(chineseRatio("中 a b c d e f g h i")).toBeCloseTo(0.1);
		expect(chineseRatio("中abcdefghij")).toBeLessThan(CHINESE_RATIO_THRESHOLD);
	});

	it("paginates large Chinese files into <= 3 KiB raw UTF-8 previews with parallel page offsets", async () => {
		const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"支付需求开发礼金有效期".repeat(3)}`);
		const content = lines.join("\n");
		const f = fixture(content);
		const result = await f.read();
		const text = textOf(result);
		expect(text).toContain(`[File: ${f.file} | Total: 250 lines, ${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB]`);
		expect(text).toContain("parallel page offsets:");
		expect(text.split("\n")[1]).toMatch(/^\[Summary: Chinese text \(\d+\.\d% Chinese characters\)\. Preview: lines 1-\d+ below\. If the preview is enough, stop here; otherwise call pi_read for every page offset listed at the end, in parallel in one turn\.\]$/u);
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
		const body = text.split("\n").slice(2, -2).join("\n");
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3072);
		expect(Buffer.byteLength(body)).toBeGreaterThan(2900);
		expect(body).toBe(lines.slice(0, body.split("\n").length).join("\n"));
	});

	it("reconstructs the entire Chinese file in 2 turns using the advertised parallel page offsets", async () => {
		const content = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"中文🙂礼金渠道打通".repeat(4)}`).join("\n") + "\n";
		const f = fixture(content);
		const firstText = textOf(await f.read());
		expect(firstText).toContain("Total: 251 lines");
		expect(Buffer.byteLength(firstText)).toBeLessThan(4096);

		const footerMatch = /\n\.\.\.\n\[\d+ lines remaining\. If more content is needed, use offset=(\d+) to continue \(parallel page offsets: ([0-9, ]+)\)\.\]$/u.exec(firstText);
		expect(footerMatch).not.toBeNull();
		const firstBody = firstText.slice(firstText.indexOf("\n", firstText.indexOf("\n") + 1) + 1, footerMatch!.index);
		const offsets = footerMatch![2]!.split(", ").map(Number);
		expect(offsets[0]).toBe(Number(footerMatch![1]));

		// Read all remaining pages in parallel in one batch, just like the model does.
		const parallelResults = await Promise.all(offsets.map((offset) => f.read({ offset })));
		const parallelBodies = parallelResults.map((res) => {
			const pageText = textOf(res);
			expect(pageText).not.toContain("[Summary:");
			expect(Buffer.byteLength(pageText)).toBeLessThan(4096);
			expect(pageText).not.toContain("\ufffd");
			const match = /\n\.\.\.\n\[\d+ lines remaining\./u.exec(pageText);
			return pageText.slice(pageText.indexOf("\n") + 1, match?.index);
		});

		expect([firstBody, ...parallelBodies].join("\n")).toBe(content);
	});

	it("honors offset and limit on Chinese files even when the requested page is small", async () => {
		const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}: ${"礼金测试".repeat(8)}`);
		const f = fixture(lines.join("\n"));
		const text = textOf(await f.read({ offset: 81, limit: 2 }));
		expect(text.split("\n").slice(1, -2).join("\n")).toBe(lines.slice(80, 82).join("\n"));
		expect(text).toContain("168 lines remaining. If more content is needed, use offset=83 to continue.");
		expect(text).not.toContain("parallel page offsets:");
		const last = textOf(await f.read({ offset: 250 }));
		expect(last.endsWith(lines[249]!)).toBe(true);
		expect(last).not.toContain("offset=");
	});

	it("shows a bounded prefix for an oversized single Chinese line without a false next-line offset", async () => {
		const f = fixture("中".repeat(2000));
		const text = textOf(await f.read());
		expect(text).toContain("Total: 1 lines, 5.9 KiB");
		expect(text).toContain("only its prefix is shown");
		expect(text).not.toContain("offset=");
		expect(text).not.toContain("\ufffd");
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
	});

	it("retains full-file totals on Chinese files beyond Pi's own 50 KiB truncation", async () => {
		const f = fixture(Array.from({ length: 250 }, () => "汉".repeat(350)).join("\n"));
		const text = textOf(await f.read());
		expect(text).toContain("Total: 250 lines, 256.6 KiB");
		expect(text).toContain("248 lines remaining. If more content is needed, use offset=3 to continue");
		expect(Buffer.byteLength(text)).toBeLessThan(4096);
	});

	it("keeps the original reader for other providers", async () => {
		const f = fixture("中".repeat(2000));
		const ctx = { ...f.ctx, model: { ...f.ctx.model!, provider: "other" } };
		const result = await f.tool.execute("read-test", { path: f.file }, undefined, undefined, ctx);
		expect(textOf(result)).toBe("中".repeat(2000));
	});

	it("preserves images and their original structured output", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
		const f = fixture(png, "image.png");
		const result = await f.read();
		const original = await createReadToolDefinition(f.cwd).execute("read-test", { path: f.file }, undefined, undefined, f.ctx);
		expect(result).toEqual(original);
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	it("preserves errors and cancellation from the original reader", async () => {
		const f = fixture("一\n二");
		await expect(f.read({ offset: 3 })).rejects.toThrow("beyond end of file");
		await expect(f.tool.execute("read-test", { path: "missing.txt" }, undefined, undefined, f.ctx)).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(f.read({}, controller.signal)).rejects.toThrow("Operation aborted");
	});

	it("sends the bounded Chinese preview through the MCP bridge within 4096 bytes", async () => {
		const f = fixture(Array.from({ length: 250 }, (_, i) => `${i}: ${"中文内容测试".repeat(6)}`).join("\n"));
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
