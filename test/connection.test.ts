import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { sessionModels, sessionModes } from "../src/acp/session-state.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

describe("AntigravityAcpConnection", () => {
	it("ignores known browser-launch stdout noise", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "browser-noise"],
		});
		try {
			await expect(connection.initialize()).resolves.toMatchObject({
				agentInfo: { name: "fake-gemini" },
			});
			expect(connection.process.ignoredStdoutNoiseLines).toBe(1);
		} finally {
			await connection.close();
		}
	});

	it("rejects malformed output without an unhandled SDK receive rejection", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "malformed-output"],
			initializeTimeoutMs: 5_000,
		});
		try {
			await expect(connection.initialize()).rejects.toThrow("malformed JSON");
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});

	it("rejects promptly and quietly when the agent exits before a request", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "exit-after-initialize"],
			operationTimeoutMs: 5_000,
		});
		try {
			await connection.initialize();
			await connection.process.exited;
			const started = Date.now();
			const error = await connection.newSession(process.cwd()).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("write after end");
			expect(Date.now() - started).toBeLessThan(500);
			expect(
				errorSpy.mock.calls.some((call) => String(call[0]).includes("ACP write error")),
			).toBe(false);
		} finally {
			errorSpy.mockRestore();
			await connection.close();
		}
	});

	it("reports a session timeout without leaking an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "session-timeout"],
			operationTimeoutMs: 25,
		});
		try {
			await connection.initialize();
			await expect(connection.newSession(process.cwd())).rejects.toThrow(
				"Antigravity ACP session/new timed out after 25ms",
			);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await connection.close();
		}
	});

	it("cancels a hanging prompt and keeps the session usable", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
		});
		try {
			await connection.initialize();
			const session = await connection.newSession(process.cwd());
			const controller = new AbortController();
			const pending = connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hang" }],
			}, controller.signal);
			const assertion = expect(pending).rejects.toThrow(/cancel|abort/iu);
			controller.abort();
			await assertion;
			expect(connection.process.alive).toBe(true);
			await expect(connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			})).resolves.toMatchObject({ stopReason: "end_turn" });
		} finally {
			await connection.close();
		}
	});

	it.each([false, true])("rejects a pending prompt on process exit (signal: %s)", async (withSignal) => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
		});
		try {
			await connection.initialize();
			const sdk = (connection as unknown as { connection: ClientSideConnection }).connection;
			// The SDK response never arrives: the provider must observe process exit itself.
			vi.spyOn(sdk, "prompt").mockReturnValue(new Promise(() => {}));
			const pending = connection.prompt({
				sessionId: "fake-session",
				prompt: [{ type: "text", text: "hang" }],
			}, withSignal ? new AbortController().signal : undefined);
			const assertion = expect(pending).rejects.toThrow("Antigravity ACP process exited");
			connection.process.child.kill("SIGKILL");
			await assertion;
		} finally {
			await connection.close();
		}
	});

	it.each([false, true])("rejects malformed output during a prompt (signal: %s)", async (withSignal) => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "malformed-prompt"],
		});
		try {
			await connection.initialize();
			const session = await connection.newSession(process.cwd());
			await expect(connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}, withSignal ? new AbortController().signal : undefined)).rejects.toThrow("malformed JSON");
		} finally {
			await connection.close();
		}
	});

	it("includes safe structured details in ACP errors", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "internal-error"],
		});
		try {
			await connection.initialize();
			const error = await connection.newSession(process.cwd()).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Internal error: Permission denied: localharness_external",
			);
			expect((error as Error).message).toContain("api_key=<redacted>");
			expect((error as Error).message).not.toContain("AIza1234567890abcdefghijkl");
		} finally {
			await connection.close();
		}
	});

	it("uses stable grouped config options for discovery, model/mode selection and restoration", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent), command: process.execPath, args: [fakeAgent, "config-options"],
		});
		try {
			const session = await connection.newSession(process.cwd());
			expect(session.models).toBeUndefined();
			expect(sessionModels(session)?.availableModels).toEqual([
				{ modelId: "auto", name: "Auto" }, { modelId: "gemini-test", name: "Gemini Test" },
			]);
			await connection.setModel(session.sessionId, "gemini-test");
			await connection.setMode(session.sessionId, "yolo");
			const resumed = await connection.resumeSession(session.sessionId, process.cwd());
			expect(sessionModels(resumed)?.currentModelId).toBe("gemini-test");
			expect(sessionModes(resumed)?.currentModeId).toBe("yolo");
			const loaded = await connection.loadSession(session.sessionId, process.cwd());
			expect(sessionModels(loaded)?.currentModelId).toBe("gemini-test");
		} finally {
			await connection.close();
		}
	});

	it.each(["stream progress", "native work"])("keeps an active %s turn alive beyond the idle budget", async (text) => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent], env: { ...process.env, FAKE_PROGRESS_STEP_MS: "60" }, promptIdleTimeoutMs: 300, promptWorkIdleTimeoutMs: 1500 });
		try {
			const session = await connection.newSession(process.cwd());
			expect((await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text }] })).stopReason).toBe("end_turn");
			expect(connection.process.alive).toBe(true);
		} finally { await connection.close(); }
	});

	it("bounds native tools that never report completion", async () => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent], promptIdleTimeoutMs: 300, promptWorkIdleTimeoutMs: 600 });
		try {
			const session = await connection.newSession(process.cwd());
			await expect(connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "native stuck" }] })).rejects.toThrow("no tool/permission progress for 600ms");
			await connection.process.exited;
			expect(connection.process.alive).toBe(false);
		} finally { await connection.close(); }
	});

	it("holds a parked Pi call until release, then detects a silent prompt", async () => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath,
			args: [fakeAgent], promptIdleTimeoutMs: 100, promptWorkIdleTimeoutMs: 1000 });
		try {
			const session = await connection.newSession(process.cwd());
			const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] });
			const rejection = expect(pending).rejects.toThrow("no progress for 100ms");
			const release = connection.holdPromptWatchdog(session.sessionId);
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(connection.process.alive).toBe(true);
			release(); release(); await rejection;
		} finally { await connection.close(); }
	});

	it("rejects invalid inactivity options before starting a child", () => {
		expect(() => new AntigravityAcpConnection({ cwd: process.cwd(), command: process.execPath, args: [fakeAgent], promptIdleTimeoutMs: Infinity })).toThrow(RangeError);
	});

	it("uses the official SDK against a real child process", async () => {
		const updates: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
			handlers: {
				onUpdate: (notification) => {
					updates.push(notification.update.sessionUpdate);
				},
			},
		});
		try {
			const initialize = await connection.initialize();
			expect(initialize.agentInfo?.name).toBe("fake-gemini");
			await connection.authenticate({ methodId: "api", _meta: { "api-key": "secret" } });
			const session = await connection.newSession(process.cwd());
			expect(session.models?.availableModels).toHaveLength(2);
			await connection.setModel(session.sessionId, "gemini-test");
			const response = await connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});
			expect(response.stopReason).toBe("end_turn");
			expect(updates).toEqual(["agent_thought_chunk", "agent_message_chunk"]);
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});
});
