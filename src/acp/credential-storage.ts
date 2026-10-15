import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveAntigravityAcpDirectory } from "./antigravity.js";

/** Selects the Antigravity ACP server's secure-file credential backend
 * (`credential_store.py`: `AGY_ACP_FORCE_FILE_STORAGE`). */
export const FORCE_FILE_STORAGE_ENV = "AGY_ACP_FORCE_FILE_STORAGE";

/** macOS keychain coordinates of the server's credentials:
 * `credential_store.KEYCHAIN_SERVICE` and the consumer/business `_KEYCHAIN_ACCOUNT`. */
export const KEYCHAIN_SERVICE = "gemini";
export const KEYCHAIN_ACCOUNT = "antigravity-acp";
export const KEYCHAIN_BUSINESS_ACCOUNT = "antigravity-acp-business";

/** Keychain account -> secure-file name the server uses for the same flavor
 * (`_CONSUMER_TOKEN_FILE_NAME` / `_BUSINESS_TOKEN_FILE_NAME`). */
const KEYCHAIN_FILE_PAIRS: ReadonlyArray<readonly [account: string, fileName: string]> = [
	[KEYCHAIN_ACCOUNT, "acp_token.json"],
	[KEYCHAIN_BUSINESS_ACCOUNT, "acp_business_token.json"],
];

const SECURITY_CLI = "/usr/bin/security";
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 3_000;

export type CredentialStorageReason = "explicit-override" | "not-darwin" | "file-default";

export interface CredentialStorageDecision {
	/** Child environment entries to apply; empty when the server default is used. */
	env: Record<string, string>;
	reason: CredentialStorageReason;
}

export interface CredentialStorageOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Overrides the consumer token path (tests). */
	tokenPath?: string;
	/** Injectable keychain reader for the one-time migration; returns the stored
	 * secret or undefined when absent/unreadable. */
	keychainSecret?: (service: string, account: string) => string | undefined;
}

function defaultKeychainSecret(service: string, account: string): string | undefined {
	// Never copy the developer's real keychain secret into test fixtures.
	if (process.env.VITEST) return undefined;
	try {
		return execFileSync(SECURITY_CLI, ["find-generic-password", "-s", service, "-a", account, "-w"], {
			timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
	} catch {
		// Absent, locked, denied, or timed out: nothing to migrate.
		return undefined;
	}
}

/** On macOS the server prefers the login keychain, but it decides that with a
 * set/get/delete probe bounded to 3 s at every process start. When the system
 * is busy (many concurrent Pi sessions each spawn their own server) the probe
 * can time out; the server then silently falls back to the empty secure file
 * and opens interactive Google consent even though a valid login exists.
 *
 * The provider therefore pins every spawned server to the secure-file backend
 * (`~/.gemini/antigravity-acp/acp_token.json`, 0600) by default, which is the
 * same backend the server always uses off macOS. Set
 * `AGY_ACP_FORCE_FILE_STORAGE` yourself (e.g. `0`) to take over the choice.
 *
 * `options.env` is the environment of the child the decision applies to. */
export function resolveCredentialStorageDecision(
	options: CredentialStorageOptions = {},
): CredentialStorageDecision {
	const env = options.env ?? process.env;
	if (env[FORCE_FILE_STORAGE_ENV]?.trim()) return { env: {}, reason: "explicit-override" };

	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return { env: {}, reason: "not-darwin" };

	return { env: { [FORCE_FILE_STORAGE_ENV]: "1" }, reason: "file-default" };
}

function hasRefreshToken(raw: string): boolean {
	try {
		const token = JSON.parse(raw) as { refresh_token?: unknown };
		return typeof token.refresh_token === "string" && token.refresh_token.length > 0;
	} catch {
		return false;
	}
}

function writeSecureFile(target: string, content: string): void {
	const directory = path.dirname(target);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		// Another process may have created the file meanwhile; keep theirs.
		if (fs.existsSync(target)) return;
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/** One-time migration for the file default: copies a login the server kept in
 * the macOS keychain into the matching secure file when that file is absent,
 * so switching backends never forces a new Google login. Returns the files it
 * created. Failures are ignored; the server then asks for a login as usual. */
export function migrateKeychainCredentialsToFile(options: CredentialStorageOptions = {}): string[] {
	const env = options.env ?? process.env;
	if (resolveCredentialStorageDecision(options).reason !== "file-default") return [];
	const directory = options.tokenPath ? path.dirname(options.tokenPath) : resolveAntigravityAcpDirectory(env);
	const read = options.keychainSecret ?? defaultKeychainSecret;
	const created: string[] = [];
	for (const [account, fileName] of KEYCHAIN_FILE_PAIRS) {
		const target =
			account === KEYCHAIN_ACCOUNT && options.tokenPath ? options.tokenPath : path.join(directory, fileName);
		if (fs.existsSync(target)) continue;
		const secret = read(KEYCHAIN_SERVICE, account);
		if (!secret || !hasRefreshToken(secret)) continue;
		try {
			writeSecureFile(target, secret);
			if (fs.existsSync(target)) created.push(target);
		} catch {
			// Unwritable store: leave it to the server's normal login flow.
		}
	}
	return created;
}

/** Applies the decision (and the one-time keychain migration it implies)
 * without mutating `baseEnv`, mirroring the other child-only environment
 * adapters. `baseEnv` is the environment the child receives. */
export function applyCredentialStorageEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	options: Omit<CredentialStorageOptions, "env"> = {},
): NodeJS.ProcessEnv {
	const decision = resolveCredentialStorageDecision({ ...options, env: baseEnv });
	if (decision.reason === "file-default") migrateKeychainCredentialsToFile({ ...options, env: baseEnv });
	return { ...baseEnv, ...decision.env };
}

/** Describes the backend the next child process is expected to use, for
 * `doctor`/`status` diagnostics. */
export function describeCredentialStorage(options: CredentialStorageOptions = {}): string {
	const decision = resolveCredentialStorageDecision(options);
	switch (decision.reason) {
		case "file-default":
			return `secure file (provider default: spawned servers are pinned with ${FORCE_FILE_STORAGE_ENV}=1; set it yourself to override)`;
		case "explicit-override":
			return `${FORCE_FILE_STORAGE_ENV} set by the user`;
		default:
			return "server default (secure file)";
	}
}
