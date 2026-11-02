import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { findSessionSelector, sessionModels } from "../src/acp/session-state.js";
import { projectModels } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";
import { AntigravityRuntime } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/model-selection-agent.mjs", import.meta.url));
function connection(scenario: string, options: Partial<AntigravityConnectionOptions> = {}) {
	return new AntigravityAcpConnection({ cwd: process.cwd(), ...options, command: process.execPath, args: [fixture, scenario] });
}

// These tests use the actual ACP SDK/transport and runtime, not mocks of the
// selector methods. The child reports the model it really used in each reply.
describe("model selection integration", () => {
	it.each(["split", "thinking-alias", "thought-alias", "category-only"])("can select every discovered ID and restore it (%s)", async (scenario) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			for (const model of sessionModels(session)!.availableModels) {
				await acp.setModel(session.sessionId, model.modelId);
				expect(sessionModels(acp.getSessionState(session.sessionId))?.currentModelId).toBe(model.modelId);
			}
			await acp.setModel(session.sessionId, "gemini-b-low");
			await acp.setModel(session.sessionId, "gemini-b-medium");
			expect(sessionModels(await acp.resumeSession(session.sessionId, process.cwd()))?.currentModelId).toBe("gemini-b-medium");
			expect(sessionModels(await acp.loadSession(session.sessionId, process.cwd()))?.currentModelId).toBe("gemini-b-medium");
		} finally { await acp.close(); }
	});

	it("prefers an exact native model ID to splitting a matching suffix", async () => {
		const acp = connection("native-id");
		try {
			const session = await acp.newSession(process.cwd());
			await acp.setModel(session.sessionId, "gemini-a-low");
			const state = acp.getSessionState(session.sessionId);
			expect(findSessionSelector(state, "model")?.currentValue).toBe("gemini-a-low");
			expect(findSessionSelector(state, "thought_level")?.currentValue).toBe("high");
		} finally { await acp.close(); }
	});

	it.each(["legacy", "ignored-base"])("falls back after a silently ignored selector update (%s)", async (scenario) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			await acp.setModel(session.sessionId, "gemini-b-low");
			expect(sessionModels(await acp.resumeSession(session.sessionId, process.cwd()))?.currentModelId).toBe("gemini-b-low");
		} finally { await acp.close(); }
	});

	it.each([
		["disappearing", "did not confirm the requested thought_level selection"],
		["reject-low", "did not confirm the requested thought_level selection"],
		["model-drift", "changed the model during thought_level selection"],
	])("does not claim success after a partial selection (%s)", async (scenario, message) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			await expect(acp.setModel(session.sessionId, "gemini-b-low")).rejects.toThrow(message);
		} finally { await acp.close(); }
	});

	it.each([
		["selector-auth", "auth"],
		["selector-protocol", "protocol"],
	])("does not treat a real selector error as a fallback opportunity (%s)", async (scenario, code) => {
		const acp = connection(scenario);
		try {
			const session = await acp.newSession(process.cwd());
			await expect(acp.setModel(session.sessionId, "gemini-b-low")).rejects.toMatchObject({
				code, message: expect.stringContaining("Selector update rejected"), cause: expect.any(Error),
			});
		} finally { await acp.close(); }
	});

	it.each([
		["legacy-auth", "auth", "Token expired"],
		["legacy-timeout", "timeout", "session/set_model timed out"],
	])("preserves classified failures from the legacy method (%s)", async (scenario, code, message) => {
		const acp = connection(scenario, { operationTimeoutMs: 200 });
		try {
			const session = await acp.newSession(process.cwd());
			const error = await acp.setModel(session.sessionId, "gemini-b-low").catch((cause: unknown) => cause);
			expect(error).toMatchObject({ code, message: expect.stringContaining(message) });
			if (code === "auth") expect(error).toHaveProperty("cause", expect.objectContaining({ code: -32000, message: "Token expired" }));
		} finally { await acp.close(); }
	});

	it("does not replace a legacy transport exit with a generic selection error", async () => {
		const acp = connection("legacy-exit");
		try {
			const session = await acp.newSession(process.cwd());
			const error = await acp.setModel(session.sessionId, "gemini-b-low").catch((cause: unknown) => cause);
			// EOF and the child exit event race; either original transport diagnostic
			// is useful, unlike the old blanket protocol-selection replacement.
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toMatchObject({ code: "protocol" });
			expect((error as Error).message).toMatch(/ACP connection closed|process exited/u);
			expect(await acp.process.exited).toMatchObject({ code: 7 });
		} finally { await acp.close(); }
	});

	it("cancels an in-flight legacy selection without replacing the abort diagnostic", async () => {
		const acp = connection("legacy-timeout");
		const controller = new AbortController();
		try {
			const session = await acp.newSession(process.cwd());
			const pending = acp.setModel(session.sessionId, "gemini-b-low", controller.signal);
			const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
			setTimeout(() => controller.abort(), 50);
			await rejected;
		} finally { controller.abort(); await acp.close(); }
	});

	it("publishes discovered reasoning models and applies effort changes on a warm provider session", async () => {
		const runtime = new AntigravityRuntime((options) => connection("split", options));
		const { provider } = createAntigravityProvider(runtime);
		try {
			let published = false;
			await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
				publish: async ({ update }) => { update?.(); published = true; return true; } });
			expect(published).toBe(true);
			const model = provider.getModels().find((candidate) => candidate.id === "gemini-b")!;
			expect(model).toMatchObject({ reasoning: true, thinkingLevelMap: { low: "gemini-b-low", high: "gemini-b-high" } });
			const firstContext = { messages: [{ role: "user" as const, content: "first", timestamp: 1 }] };
			const first = await runtime.stream(model, firstContext, { sessionId: "warm-effort", reasoning: "low" }).stream.result();
			expect(first.content).toEqual([{ type: "text", text: "gemini-b/low" }]);
			const generation = (await runtime.snapshot()).processes[0]?.generation;
			const second = await runtime.stream(model, { messages: [...firstContext.messages, first,
				{ role: "user", content: "second", timestamp: 2 }] }, { sessionId: "warm-effort", reasoning: "high" }).stream.result();
			expect(second.content).toEqual([{ type: "text", text: "gemini-b/high" }]);
			expect((await runtime.snapshot()).processes[0]?.generation).toBe(generation);
		} finally { await runtime.close(); }
	});

	it("discards both warm and saved bindings after a partial selection, then safely retries the original model", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-selection-recovery-"));
		const store = new AcpSessionStore(path.join(directory, "sessions.json"));
		const connections: AntigravityAcpConnection[] = [];
		const runtime = new AntigravityRuntime((options) => {
			const acp = connection("reject-low", options);
			connections.push(acp);
			return acp;
		}, "default", store);
		const models = projectModels(["a", "b"].flatMap((base) => ["low", "medium", "high"].map((effort) => ({
			modelId: `gemini-${base}-${effort}`, name: `Gemini ${base.toUpperCase()} (${effort})`,
		}))));
		const modelA = models.find((model) => model.id === "gemini-a")!;
		const modelB = models.find((model) => model.id === "gemini-b")!;
		const context = { messages: [{ role: "user" as const, content: "first", timestamp: 1 }] };
		const options = { sessionId: "selection-recovery", reasoning: "high" as const };
		try {
			const first = await runtime.stream(modelA, context, options).stream.result();
			expect(first.content).toEqual([{ type: "text", text: "gemini-a/high" }]);
			expect(store.get(options.sessionId)).toBeDefined();
			const next = { messages: [...context.messages, first, { role: "user" as const, content: "next", timestamp: 2 }] };
			const failed = await runtime.stream(modelB, next, { ...options, reasoning: "low" }).stream.result();
			expect(failed.stopReason).toBe("error");
			expect((await runtime.snapshot()).bindings).toBe(0);
			expect(store.get(options.sessionId)).toBeUndefined();
			expect(connections[0]?.process.alive).toBe(false);
			const retry = await runtime.stream(modelA, next, options).stream.result();
			expect(retry.content).toEqual([{ type: "text", text: "gemini-a/high" }]);
			expect(connections).toHaveLength(2);
		} finally { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); }
	});
});
