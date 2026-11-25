import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { PiEventWriter } from "../src/stream/pi-events.js";
import { contextUsage } from "../src/stream/usage.js";

const model: Model<Api> = {
	id: "test",
	name: "Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

describe("PiEventWriter", () => {
	it("balances blocks when switching thought and text", async () => {
		const writer = new PiEventWriter(model);
		writer.thinking("think");
		writer.text("answer");
		writer.done("stop");
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
	});

	it("emits a valid empty response", async () => {
		const writer = new PiEventWriter(model);
		writer.done("stop");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_end", "done"]);
	});

	it("emits a complete synthetic tool call", async () => {
		const writer = new PiEventWriter(model);
		writer.toolCall("call-1", "permission", { requestId: "one" });
		writer.done("toolUse");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(writer.message.stopReason).toBe("toolUse");
	});

	it("preserves nested JSON tool arguments", () => {
		const writer = new PiEventWriter(model);
		const args = { nested: [null, true, 4, { text: "value" }] };
		writer.toolCall("call-json", "echo", args);
		expect(writer.message.content[0]).toMatchObject({ arguments: args });
	});

	it.each([undefined, NaN, Infinity, 1n, () => true, new Date()])("rejects non-JSON tool input: %s", (value) => {
		const writer = new PiEventWriter(model);
		expect(() => writer.toolCall("call-invalid", "echo", { value })).toThrow("valid JSON object");
		expect(writer.message.content).toHaveLength(0);
	});

	it("rejects cyclic tool input without overflowing the stack", () => {
		const args: Record<string, unknown> = {};
		args.self = args;
		expect(() => new PiEventWriter(model).toolCall("call-cycle", "echo", args)).toThrow("valid JSON object");
	});

	it("terminates errors once", async () => {
		const writer = new PiEventWriter(model);
		writer.fail(new Error("failed"));
		writer.done("stop");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
	});

	it("accumulates output tokens and advances context tokens across multi-step usage updates", async () => {
		const writer = new PiEventWriter(model);
		const seenOutputs: number[] = [];
		const seenTotals: number[] = [];
		const drain = (async () => {
			for await (const event of writer.stream) {
				if (event.type === "start" || event.type === "thinking_delta" || event.type === "text_delta") {
					seenOutputs.push(event.partial.usage.output);
					seenTotals.push(event.partial.usage.totalTokens);
				}
			}
		})();

		// Step 1: silent native tool step completes with 380 output tokens before any text/thinking.
		writer.recordStepUsage(contextUsage(10_380, { input: 10_000, cacheRead: 0, output: 380 }));
		// Step 2: streams 40 chars of thinking (+10 estimated tokens) before its usage_update arrives.
		writer.thinking("a".repeat(40));
		// Step 2 completes with 210 output tokens (smaller than step 1, must sum to 590, not drop to 210).
		writer.recordStepUsage(contextUsage(12_210, { input: 2_000, cacheRead: 10_000, output: 210 }));
		// Step 3: streams 80 chars of answer (+20 estimated tokens), then completes with 500 output tokens.
		writer.text("b".repeat(80));
		writer.recordStepUsage(contextUsage(15_500, { input: 3_000, cacheRead: 12_000, output: 500 }));
		writer.done("stop");
		await drain;

		expect(seenOutputs).toEqual([380, 390, 590, 610, 1090]);
		expect(seenTotals).toEqual([10_380, 10_390, 12_210, 12_230, 15_500]);
		expect(writer.cumulativeOutputTokens).toBe(1090);
		expect(writer.message.usage).toMatchObject({
			input: 3_000,
			cacheRead: 12_000,
			output: 1090,
			totalTokens: 15_500,
		});
		expect(writer.message.content).toEqual([
			{ type: "thinking", thinking: "a".repeat(40) },
			{ type: "text", text: "b".repeat(80) },
		]);
	});

	it("notifies Pi when a fallback usage_update reports context tokens without step output", async () => {
		const writer = new PiEventWriter(model);
		const seenTotals: number[] = [];
		const drain = (async () => {
			for await (const event of writer.stream) {
				if (event.type === "start" || event.type === "thinking_delta" || event.type === "text_delta") {
					seenTotals.push(event.partial.usage.totalTokens);
				}
			}
		})();

		writer.recordStepUsage(contextUsage(42_000, { input: 42_000, cacheRead: 0, output: 0 }));
		writer.thinking("c".repeat(40));
		writer.done("stop");
		await drain;

		expect(seenTotals).toEqual([42_000, 42_010]);
	});

	it("keeps streaming usage unseeded until a live usage_update arrives, falling back only on done", async () => {
		const writer = new PiEventWriter(model);
		writer.seedFallbackContextTokens(30_000);
		const streamedTotals: number[] = [];
		const drain = (async () => {
			for await (const event of writer.stream) {
				if (event.type === "start" || event.type === "thinking_delta" || event.type === "text_delta") {
					streamedTotals.push(event.partial.usage.totalTokens);
				}
			}
		})();

		writer.thinking("planning");
		writer.toolCall("call-1", "pi_codemode", { code: "return 1" });
		writer.done("toolUse");
		await drain;

		expect(streamedTotals).toEqual([0, 0]);
		expect(writer.message.usage).toMatchObject({ input: 0, cacheRead: 0, output: 0, totalTokens: 30_000 });
	});

	it("closes an open block on endBlock and reopens cleanly on subsequent thinking", async () => {
		const writer = new PiEventWriter(model);
		writer.thinking("step 1");
		writer.endBlock();
		writer.endBlock();
		writer.thinking("step 2");
		writer.text("done");
		writer.endBlock();
		writer.done("stop");
		const events = [];
		for await (const event of writer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(writer.message.content).toEqual([
			{ type: "thinking", thinking: "step 1" },
			{ type: "thinking", thinking: "step 2" },
			{ type: "text", text: "done" },
		]);
	});
});
