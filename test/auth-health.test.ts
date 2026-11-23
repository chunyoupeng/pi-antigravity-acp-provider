import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	inspectAntigravityAuth,
	resolveAgyCliAppDataDir,
} from "../src/acp/antigravity.js";

const apiKey = process.env.GEMINI_API_KEY;
beforeEach(() => {
	delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
	if (apiKey !== undefined) process.env.GEMINI_API_KEY = apiKey;
});

describe("Antigravity auth health", () => {
	it("recognizes an OAuth token held in the macOS Keychain", () => {
		const health = inspectAntigravityAuth({}, () => true);
		expect(health).toEqual({
			status: "oauth-refreshable",
			authType: "oauth-personal",
			credentialStore: "keychain",
		});
	});

	it("reports missing when neither API key nor keychain entry exists", () => {
		expect(inspectAntigravityAuth({}, () => false)).toEqual({ status: "missing" });
	});

	it("reads the API key from the inspected environment only", () => {
		expect(inspectAntigravityAuth({ GEMINI_API_KEY: "child-key" }, () => false)).toEqual({
			status: "api-key-env",
			authType: "gemini-api-key",
		});
		expect(inspectAntigravityAuth({}, () => false).status).toBe("missing");
	});

	it("resolves the agy CLI app data dir from HOME and GEMINI_HOME", () => {
		expect(resolveAgyCliAppDataDir({ HOME: "/child/home" })).toBe(
			path.join("/child/home", ".gemini", "antigravity-cli"),
		);
		expect(resolveAgyCliAppDataDir({ HOME: "/child/home", GEMINI_HOME: "/child/workspace" })).toBe(
			path.join("/child/workspace", "antigravity-cli"),
		);
		expect(resolveAgyCliAppDataDir({ HOME: os.homedir(), GEMINI_HOME: "  " })).toBe(
			path.join(os.homedir(), ".gemini", "antigravity-cli"),
		);
	});
});
