import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	applyCredentialStorageEnvironment,
	FORCE_FILE_STORAGE_ENV,
	KEYCHAIN_ACCOUNT,
	KEYCHAIN_BUSINESS_ACCOUNT,
	KEYCHAIN_SERVICE,
	migrateKeychainCredentialsToFile,
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

const refreshable = '{"refresh_token":"fixture","client_id":"fixture"}';
const businessRefreshable = '{"refresh_token":"business","client_id":"fixture"}';

describe("macOS credential storage selection", () => {
	it("pins the server to the secure file by default", () => {
		for (const content of [undefined, refreshable]) {
			const decision = resolveCredentialStorageDecision({
				env: {},
				platform: "darwin",
				tokenPath: tokenPathWith(content),
			});
			expect(decision).toEqual({ env: { [FORCE_FILE_STORAGE_ENV]: "1" }, reason: "file-default" });
		}
	});

	it("keeps the platform default outside macOS", () => {
		const decision = resolveCredentialStorageDecision({ env: {}, platform: "linux" });
		expect(decision).toEqual({ env: {}, reason: "not-darwin" });
	});

	it("honors an explicit user override, including opting back into the keychain", () => {
		for (const value of ["1", "true", "0"]) {
			const decision = resolveCredentialStorageDecision({
				env: { [FORCE_FILE_STORAGE_ENV]: value },
				platform: "darwin",
			});
			expect(decision).toEqual({ env: {}, reason: "explicit-override" });
		}
	});

	it("applies the decision without mutating the inherited environment", () => {
		const source: NodeJS.ProcessEnv = { TERM: "xterm-256color", PATH: "/usr/bin" };
		const result = applyCredentialStorageEnvironment(source, {
			platform: "darwin",
			tokenPath: tokenPathWith(refreshable),
			keychainSecret: () => undefined,
		});
		expect(result[FORCE_FILE_STORAGE_ENV]).toBe("1");
		expect(result.PATH).toBe("/usr/bin");
		expect(result.TERM).toBe("xterm-256color");
		expect(source[FORCE_FILE_STORAGE_ENV]).toBeUndefined();
	});
});

describe("one-time keychain migration", () => {
	it("copies keychain logins into absent secure files with 0600 permissions", () => {
		const tokenPath = tokenPathWith(undefined);
		const read = vi.fn((_service: string, account: string) =>
			account === KEYCHAIN_ACCOUNT ? refreshable : account === KEYCHAIN_BUSINESS_ACCOUNT ? businessRefreshable : undefined,
		);
		const created = migrateKeychainCredentialsToFile({ env: {}, platform: "darwin", tokenPath, keychainSecret: read });
		const businessPath = path.join(path.dirname(tokenPath), "acp_business_token.json");
		expect(created).toEqual([tokenPath, businessPath]);
		expect(fs.readFileSync(tokenPath, "utf8")).toBe(refreshable);
		expect(fs.readFileSync(businessPath, "utf8")).toBe(businessRefreshable);
		expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
		expect(read).toHaveBeenCalledWith(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
	});

	it("never overwrites an existing token file", () => {
		const tokenPath = tokenPathWith('{"refresh_token":"current"}');
		const read = vi.fn((_service: string, account: string) => (account === KEYCHAIN_ACCOUNT ? refreshable : undefined));
		migrateKeychainCredentialsToFile({ env: {}, platform: "darwin", tokenPath, keychainSecret: read });
		expect(fs.readFileSync(tokenPath, "utf8")).toBe('{"refresh_token":"current"}');
		expect(read).not.toHaveBeenCalledWith(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
	});

	it("ignores missing or unusable keychain secrets", () => {
		for (const secret of [undefined, "", "not-json", '{"refresh_token":""}']) {
			const tokenPath = tokenPathWith(undefined);
			const created = migrateKeychainCredentialsToFile({
				env: {},
				platform: "darwin",
				tokenPath,
				keychainSecret: () => secret,
			});
			expect(created).toEqual([]);
			expect(fs.existsSync(tokenPath)).toBe(false);
		}
	});

	it("does not migrate outside the file default", () => {
		const read = vi.fn(() => refreshable);
		for (const options of [
			{ env: {}, platform: "linux" as const },
			{ env: { [FORCE_FILE_STORAGE_ENV]: "0" }, platform: "darwin" as const },
		]) {
			const tokenPath = tokenPathWith(undefined);
			expect(migrateKeychainCredentialsToFile({ ...options, tokenPath, keychainSecret: read })).toEqual([]);
			expect(fs.existsSync(tokenPath)).toBe(false);
		}
		expect(read).not.toHaveBeenCalled();
	});

	it("migrates into the child's own store, not the parent's", () => {
		vi.stubEnv("GEMINI_HOME", temporaryRoot());
		const childHome = temporaryRoot();
		applyCredentialStorageEnvironment(
			{ GEMINI_HOME: childHome },
			{ platform: "darwin", keychainSecret: (_s, account) => (account === KEYCHAIN_ACCOUNT ? refreshable : undefined) },
		);
		expect(fs.readFileSync(path.join(childHome, "antigravity-acp", "acp_token.json"), "utf8")).toBe(refreshable);
	});
});
