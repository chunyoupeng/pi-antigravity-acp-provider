import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	applyCredentialStorageEnvironment,
	FORCE_FILE_STORAGE_ENV,
	KEYCHAIN_ACCOUNT,
	KEYCHAIN_SERVICE,
	resolveCredentialStorageDecision,
} from "../src/acp/credential-storage.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-storage-"));
	roots.push(root);
	return root;
}

function tokenPathWith(content: string | undefined): string {
	const tokenPath = path.join(temporaryRoot(), "acp_token.json");
	if (content !== undefined) fs.writeFileSync(tokenPath, content);
	return tokenPath;
}

/** A relocated store home (`GEMINI_HOME` or `HOME`) with the server's token. */
function homeWithToken(): string {
	const home = temporaryRoot();
	const directory = path.join(home, "antigravity-acp");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "acp_token.json"), refreshable);
	return home;
}

const refreshable = '{"refresh_token":"fixture","client_id":"fixture"}';

describe("macOS credential storage selection", () => {
	it("pins the server to the secure file when the keychain entry is absent", () => {
		const lookup = vi.fn(() => false);
		const decision = resolveCredentialStorageDecision({
			env: {},
			platform: "darwin",
			tokenPath: tokenPathWith(refreshable),
			keychainEntry: lookup,
		});
		expect(decision.env).toEqual({ [FORCE_FILE_STORAGE_ENV]: "1" });
		expect(decision.reason).toBe("missing-keychain-entry");
		expect(lookup).toHaveBeenCalledWith(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
	});

	it("leaves a populated keychain authoritative", () => {
		const decision = resolveCredentialStorageDecision({
			env: {},
			platform: "darwin",
			tokenPath: tokenPathWith(refreshable),
			keychainEntry: () => true,
		});
		expect(decision.env).toEqual({});
		expect(decision.reason).toBe("keychain-entry-present");
	});

	it("never probes the keychain without a refreshable token file to reuse", () => {
		for (const content of [undefined, "not-json", '{"refresh_token":""}', '{"client_id":"fixture"}']) {
			const lookup = vi.fn(() => false);
			const decision = resolveCredentialStorageDecision({
				env: {},
				platform: "darwin",
				tokenPath: tokenPathWith(content),
				keychainEntry: lookup,
			});
			expect(decision.env).toEqual({});
			expect(decision.reason).toBe("no-refreshable-token-file");
			expect(lookup).not.toHaveBeenCalled();
		}
	});

	it("keeps the platform default outside macOS", () => {
		const lookup = vi.fn(() => false);
		const decision = resolveCredentialStorageDecision({
			env: {},
			platform: "linux",
			tokenPath: tokenPathWith(refreshable),
			keychainEntry: lookup,
		});
		expect(decision).toEqual({ env: {}, reason: "not-darwin" });
		expect(lookup).not.toHaveBeenCalled();
	});

	it("honors an explicit user override", () => {
		const lookup = vi.fn(() => false);
		for (const value of ["1", "true"]) {
			const decision = resolveCredentialStorageDecision({
				env: { [FORCE_FILE_STORAGE_ENV]: value },
				platform: "darwin",
				tokenPath: tokenPathWith(refreshable),
				keychainEntry: lookup,
			});
			expect(decision).toEqual({ env: {}, reason: "explicit-override" });
		}
		expect(lookup).not.toHaveBeenCalled();
	});

	it("applies the decision without mutating the inherited environment", () => {
		const source: NodeJS.ProcessEnv = { TERM: "xterm-256color", PATH: "/usr/bin" };
		const result = applyCredentialStorageEnvironment(source, {
			platform: "darwin",
			tokenPath: tokenPathWith(refreshable),
			keychainEntry: () => false,
		});
		expect(result[FORCE_FILE_STORAGE_ENV]).toBe("1");
		expect(result.PATH).toBe("/usr/bin");
		expect(result.TERM).toBe("xterm-256color");
		expect(source[FORCE_FILE_STORAGE_ENV]).toBeUndefined();
	});
});

describe("child environment resolution", () => {
	// The child runs with its own HOME/GEMINI_HOME/API key, which can differ
	// from the parent's. The decision must inspect the environment the child
	// actually gets, not the launching process's own.

	it("pins the child when only the child's GEMINI_HOME holds the token", () => {
		vi.stubEnv("GEMINI_HOME", temporaryRoot());
		const decision = resolveCredentialStorageDecision({
			env: { GEMINI_HOME: homeWithToken() },
			platform: "darwin",
			keychainEntry: () => false,
		});
		expect(decision.reason).toBe("missing-keychain-entry");
		expect(decision.env).toEqual({ [FORCE_FILE_STORAGE_ENV]: "1" });
	});

	it("leaves the child on the server default when only the parent holds the token", () => {
		vi.stubEnv("GEMINI_HOME", homeWithToken());
		const lookup = vi.fn(() => false);
		const decision = resolveCredentialStorageDecision({
			env: { GEMINI_HOME: temporaryRoot() },
			platform: "darwin",
			keychainEntry: lookup,
		});
		expect(decision).toEqual({ env: {}, reason: "no-refreshable-token-file" });
		expect(lookup).not.toHaveBeenCalled();
	});

	it("ignores a parent-only API key when the child has a refreshable token", () => {
		vi.stubEnv("GEMINI_HOME", temporaryRoot());
		vi.stubEnv("GEMINI_API_KEY", "parent-key");
		const decision = resolveCredentialStorageDecision({
			env: { GEMINI_HOME: homeWithToken() },
			platform: "darwin",
			keychainEntry: () => false,
		});
		expect(decision.reason).toBe("missing-keychain-entry");
	});

	it("keeps the server default when the child authenticates with its own API key", () => {
		const lookup = vi.fn(() => false);
		const decision = resolveCredentialStorageDecision({
			env: { GEMINI_HOME: homeWithToken(), GEMINI_API_KEY: "child-key" },
			platform: "darwin",
			keychainEntry: lookup,
		});
		expect(decision).toEqual({ env: {}, reason: "no-refreshable-token-file" });
		expect(lookup).not.toHaveBeenCalled();
	});

	it("resolves the child's default store from the child HOME", () => {
		vi.stubEnv("HOME", temporaryRoot());
		const childHome = temporaryRoot();
		const store = path.join(childHome, ".gemini", "antigravity-acp");
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(path.join(store, "acp_token.json"), refreshable);
		const decision = resolveCredentialStorageDecision({
			env: { HOME: childHome },
			platform: "darwin",
			keychainEntry: () => false,
		});
		expect(decision.reason).toBe("missing-keychain-entry");
	});
});
