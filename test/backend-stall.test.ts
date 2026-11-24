import type { Model } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityRuntime } from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const capacity = "Antigravity CCPA relay: transient HTTP 503 (No capacity available) on POST /v1internal:streamGenerateContent?alt=sse (attempt 2/5); retrying in 2000ms\n";
const model: Model<"antigravity-acp"> = {
	id: "gemini-test", name: "Test", api: "antigravity-acp", provider: "antigravity-acp", baseUrl: "",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000, maxTokens: 8192,
};

describe("backend stall timeouts", () => {
	it.each([
		[capacity, "HTTP 503: model capacity unavailable on the server (attempt 2/5)"],
		[capacity.replace("HTTP 503 (No capacity available)", "HTTP 500"), "HTTP 500: internal server error"],
		[capacity.replace("HTTP 503 (No capacity available)", "network error (socket hang up)"), "connection closed/reset before a complete response (EOF)"],
		["", "No upstream error has been reported; the cause of the delay is unknown."],
	])("reports the observed cause in terminal timeout without injecting assistant text (%s)", async (stderr, expected) => {
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({ ...options,
				command: process.execPath, args: [fakeAgent],
				promptStallAbortMs: 150,
			});
			const prompt = connection.prompt.bind(connection);
			vi.spyOn(connection, "prompt").mockImplementation((request, signal) => {
				const pending = prompt(request, signal);
				// Feed the same stderr stream used by the real supervisor/relay.
				connection.process.child.stderr.emit("data", stderr);
				return pending;
			});
			return connection;
		});
		try {
			const writer = runtime.stream(model, { messages: [{ role: "user", content: "hang", timestamp: 1 }] }, { sessionId: "stall-test" });
			for await (const _event of writer.stream) void _event;
			const text = writer.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			expect(text).toBe("");
			expect(writer.message.stopReason).toBe("error");
			expect(writer.message.errorMessage).toContain(expected);
			expect(writer.message.errorMessage).not.toContain("502");
		} finally {
			await runtime.close();
		}
	});

	it("does not reuse earlier turn errors and removes stderr listeners after cancellation", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(), command: process.execPath, args: [fakeAgent],
			promptStallAbortMs: 150,
		});
		try {
			const session = await connection.newSession(process.cwd());
			const listeners = connection.process.child.stderr.listenerCount("data");
			const controller = new AbortController();
			const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] }, controller.signal);
			const rejected = expect(pending).rejects.toThrow(/abort|cancel/iu);
			connection.process.child.stderr.emit("data", capacity.slice(0, 70));
			connection.process.child.stderr.emit("data", capacity.slice(70));
			controller.abort();
			await rejected;
			expect(connection.process.child.stderr.listenerCount("data")).toBe(listeners);

			// Errors logged while idle must not contaminate the next prompt either.
			connection.process.child.stderr.emit("data", capacity);
			await expect(connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] }))
				.rejects.toThrow("cause of the delay is unknown");
			expect(connection.process.child.stderr.listenerCount("data")).toBe(listeners);
		} finally {
			await connection.close();
		}
	});
});
