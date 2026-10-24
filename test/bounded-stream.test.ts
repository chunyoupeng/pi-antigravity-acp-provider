import type { AnyMessage } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { boundedNdjsonStream } from "../src/acp/bounded-stream.js";

const encoder = new TextEncoder();

describe("boundedNdjsonStream", () => {
	it("parses split and coalesced frames", async () => {
		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"jsonrpc":"2.0","id":1,"res'));
				controller.enqueue(
					encoder.encode('ult":{}}\n{"jsonrpc":"2.0","method":"session/update","params":{}}\n'),
				);
				controller.close();
			},
		});
		const stream = boundedNdjsonStream(new WritableStream<Uint8Array>(), input);
		const values: AnyMessage[] = [];
		for await (const value of stream.readable) values.push(value);
		expect(values).toHaveLength(2);
		expect(values[0]).toMatchObject({ id: 1, result: {} });
	});

	it("ignores the exact Chromium browser reuse status line", async () => {
		const ignored: string[] = [];
		const input = bytes(
			'Opening in existing browser session.\r\n{"jsonrpc":"2.0","id":1,"result":{}}\n',
		);
		const stream = boundedNdjsonStream(new WritableStream<Uint8Array>(), input, {
			onCompatibilityNoise: (line) => ignored.push(line),
		});
		const values: AnyMessage[] = [];
		for await (const value of stream.readable) values.push(value);
		expect(values).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
		expect(ignored).toEqual(["Opening in existing browser session."]);
	});

	it("rejects malformed JSON", async () => {
		const input = bytes("not-json\n");
		const stream = boundedNdjsonStream(new WritableStream<Uint8Array>(), input);
		const reader = stream.readable.getReader();
		await expect(reader.read()).rejects.toThrow("malformed JSON");
	});

	it("does not ignore similar non-protocol output", async () => {
		const input = bytes("Opening in existing browser session. unexpected\n");
		const stream = boundedNdjsonStream(new WritableStream<Uint8Array>(), input);
		const reader = stream.readable.getReader();
		await expect(reader.read()).rejects.toThrow("malformed JSON");
	});

	it("rejects an oversized partial frame", async () => {
		const input = bytes("x".repeat(1_025));
		const stream = boundedNdjsonStream(new WritableStream<Uint8Array>(), input, { maxFrameBytes: 1_024 });
		const reader = stream.readable.getReader();
		await expect(reader.read()).rejects.toThrow("exceeds 1024 bytes");
	});

	it("writes one NDJSON frame", async () => {
		const chunks: Uint8Array[] = [];
		const output = new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) });
		const stream = boundedNdjsonStream(output, bytes(""));
		const writer = stream.writable.getWriter();
		await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize" });
		writer.releaseLock();
		expect(new TextDecoder().decode(chunks[0])).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
	});

	it("replaces lone surrogates before serializing outbound NDJSON frames", async () => {
		const chunks: Uint8Array[] = [];
		const output = new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) });
		const stream = boundedNdjsonStream(output, bytes(""));
		const writer = stream.writable.getWriter();
		await writer.write({
			jsonrpc: "2.0",
			id: 1,
			method: "session/prompt",
			params: { text: `prefix${"🇹".slice(0, 1)}suffix🇹🇼` },
		});
		writer.releaseLock();
		const raw = new TextDecoder().decode(chunks[0]);
		expect(raw).not.toContain("\\ud83c");
		expect(JSON.parse(raw)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "session/prompt",
			params: { text: "prefix\uFFFDsuffix🇹🇼" },
		});
	});
});

function bytes(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text) controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}
