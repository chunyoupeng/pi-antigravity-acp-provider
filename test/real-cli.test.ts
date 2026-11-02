import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { HeadlessOAuthRelay } from "../src/acp/headless-oauth.js";
import { resolveAntigravityAcpEntry } from "../src/acp/process.js";
import { sessionModels, sessionModes } from "../src/acp/session-state.js";

const enabled = process.env.PI_ANTIGRAVITY_ACP_REAL === "1";

describe.skipIf(!enabled)("Google Antigravity ACP contract", () => {
	it("resolves the Antigravity server and completes ACP initialize", async () => {
		const entry = resolveAntigravityAcpEntry();
		expect(entry).toMatch(/agy_acp_server\.par$/u);

		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), initializeTimeoutMs: 45_000 });
		try {
			const result = await connection.initialize();
			expect(result.protocolVersion).toBe(1);
			expect(result.agentInfo?.name).toBe("antigravity-acp");
			expect(result.authMethods?.length).toBeGreaterThan(0);
			expect(result.authMethods?.some((method) => method.id === "oauth-personal")).toBe(true);
		} finally {
			await connection.close();
		}
	}, 60_000);

	it("selects every advertised model/effort and restores current settings without sending a prompt", async () => {
		const connection = new AntigravityAcpConnection({ cwd: process.cwd(), initializeTimeoutMs: 45_000 });
		try {
			const session = await connection.newSession(process.cwd());
			const models = sessionModels(session);
			expect(models?.availableModels.length).toBeGreaterThan(0);
			if (!models) throw new Error("Official runtime did not advertise models");
			for (const model of models.availableModels) {
				await connection.setModel(session.sessionId, model.modelId);
				expect(sessionModels(connection.getSessionState(session.sessionId))?.currentModelId).toBe(model.modelId);
			}
			await connection.setModel(session.sessionId, models.currentModelId);
			expect(sessionModels(connection.getSessionState(session.sessionId))?.currentModelId).toBe(models.currentModelId);
			const modes = sessionModes(session);
			if (!modes) throw new Error("Official runtime did not advertise permission modes");
			expect(modes.availableModes.map((mode) => mode.id)).toEqual(expect.arrayContaining(["default", "auto_edit", "yolo"]));
			await connection.setMode(session.sessionId, modes.currentModeId);
			expect(sessionModes(connection.getSessionState(session.sessionId))?.currentModeId).toBe(modes.currentModeId);
		} finally {
			await connection.close();
		}
	}, 150_000);

	it.skipIf(process.platform === "win32")("captures the real headless OAuth authorization URL", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-headless-contract-"));
		const relay = new HeadlessOAuthRelay({ ...process.env, HOME: home });
		const controller = new AbortController();
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(),
			env: relay.env,
			initializeTimeoutMs: 45_000,
		});
		try {
			const initialize = await connection.initialize();
			const method = initialize.authMethods?.find((candidate) => candidate.id === "oauth-personal");
			expect(method).toBeDefined();
			const authentication = connection.authenticate(
				{ methodId: method!.id },
				controller.signal,
				60_000,
			);
			const captured = await relay.waitForAuthorization(controller.signal);
			expect(captured.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/u);
			expect(captured.redirectUrl.hostname).toBe("127.0.0.1");
			controller.abort();
			await expect(authentication).rejects.toMatchObject({ code: "aborted" });
		} finally {
			controller.abort();
			relay.dispose();
			await connection.close();
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 90_000);
});
