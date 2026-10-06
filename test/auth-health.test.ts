import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearAntigravityCredentials,
	inspectAntigravityAuth,
} from "../src/acp/antigravity.js";

const roots: string[] = [];
const apiKey = process.env.GEMINI_API_KEY;
beforeEach(() => {
	delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
	if (apiKey !== undefined) process.env.GEMINI_API_KEY = apiKey;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-auth-"));
	roots.push(value);
	return value;
}

describe("Antigravity auth health", () => {
	it("does not mistake settings alone for completed authentication", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}');
		expect(inspectAntigravityAuth(directory, () => false).status).toBe("configured-not-authenticated");
	});

	it("recognizes an OAuth token held in the macOS Keychain", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}');
		const queried: Array<string | undefined> = [];
		const health = inspectAntigravityAuth(directory, (authType) => {
			queried.push(authType);
			return true;
		});
		expect(queried).toEqual(["oauth-personal"]);
		expect(health).toMatchObject({ status: "oauth-refreshable", credentialStore: "keychain", tokenFile: false });
	});

	it("recognizes a structurally refreshable token and clears it", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}');
		fs.writeFileSync(path.join(directory, "acp_token.json"), '{"refresh_token":"secret"}');
		expect(inspectAntigravityAuth(directory, () => false).status).toBe("oauth-refreshable");
		clearAntigravityCredentials(directory);
		expect(inspectAntigravityAuth(directory, () => false).status).toBe("missing");
	});

	it("reports corrupt token files", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "acp_token.json"), "not-json");
		expect(inspectAntigravityAuth(directory, () => false).status).toBe("corrupt");
	});
});
