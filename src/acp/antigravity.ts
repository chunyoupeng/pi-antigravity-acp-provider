import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AntigravityAcpError } from "./errors.js";

export interface AntigravityLaunch {
	command: string;
	args: string[];
	source: "env" | "user-bin" | "managed" | "path";
}

export function resolveAntigravityAcpLaunch(): AntigravityLaunch {
	const env = process.env.AGY_ACP_BIN?.trim();
	if (env) {
		const command = expandHome(env);
		if (executable(command)) return directOrWrapper(command, "env");
	}

	// Prefer the provider's verified active release over ambient executables.
	// AGY_ACP_BIN remains the explicit opt-out for user-managed installations.
	const managedRoot = path.join(os.homedir(), ".local", "opt", "agy-acp", "current");
	for (const name of ["agy_acp_server.par", "agy_acp_server.exe"]) {
		const managed = path.join(managedRoot, name);
		if (executable(managed)) return directOrWrapper(managed, "managed");
	}

	const userBin = path.join(os.homedir(), ".local", "bin", "agy_acp_server.par");
	if (executable(userBin)) return { command: userBin, args: [], source: "user-bin" };

	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, "agy_acp_server.par");
		if (executable(candidate)) return directOrWrapper(candidate, "path");
	}

	throw new AntigravityAcpError(
		"spawn",
		"Google Antigravity ACP server is not installed. Install/enable agy ACP or set AGY_ACP_BIN.",
	);
}

export type AntigravityAuthStatus =
	| "api-key-env"
	| "oauth-refreshable"
	| "configured-not-authenticated"
	| "corrupt"
	| "missing";

export interface AntigravityAuthHealth {
	status: AntigravityAuthStatus;
	authType?: string;
	tokenFile: boolean;
	settingsFile: boolean;
	/** Where the OAuth token was found. macOS servers prefer the Keychain. */
	credentialStore?: "file" | "keychain";
}

// The ACP server stores one generic password per OAuth flavor under this
// service on macOS, and only falls back to acp_token.json elsewhere.
const KEYCHAIN_SERVICE = "gemini";
const SECURITY_CLI = "/usr/bin/security";

function keychainAccount(authType: string | undefined): string | undefined {
	if (authType === "oauth-personal") return "antigravity-acp";
	if (authType === "oauth-business") return "antigravity-acp-business";
	return undefined;
}

function keychainEnabled(): boolean {
	const forced = process.env.AGY_ACP_FORCE_FILE_STORAGE?.trim().toLowerCase();
	return process.platform === "darwin" && forced !== "1" && forced !== "true";
}

/** Checks entry presence only; `find-generic-password` without -w/-g never
 * reads the secret, so it cannot trigger a Keychain access prompt. */
export function hasKeychainCredential(authType: string | undefined): boolean {
	const account = keychainAccount(authType);
	if (!account || !keychainEnabled()) return false;
	try {
		execFileSync(SECURITY_CLI, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], {
			stdio: "ignore",
			timeout: 3_000,
		});
		return true;
	} catch {
		return false;
	}
}

/** Removes keychain-stored logins. Runs on every logout (not only when the
 * server's `logout` RPC is unavailable): with the provider's secure-file
 * default the server only clears the file, and a leftover keychain entry would
 * be migrated back into the file on the next spawn, undoing an account switch. */
export function clearKeychainCredentials(): void {
	if (process.platform !== "darwin") return;
	for (const account of ["antigravity-acp", "antigravity-acp-business"]) {
		try {
			execFileSync(SECURITY_CLI, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], {
				stdio: "ignore",
				timeout: 3_000,
			});
		} catch {
			// Absent entries are already logged out.
		}
	}
}

/** Resolves `<home>/antigravity-acp` for the given environment: `<home>` is
 * `$GEMINI_HOME` when set and non-empty, otherwise `<HOME>/.gemini`. The server
 * relocates its whole tree -- including `acp_token.json` -- under an explicit
 * `GEMINI_HOME` (an embedding host may set it per workspace), and a child
 * process can run with a different `HOME`/`GEMINI_HOME` than the one that
 * spawned it, so credential inspection must pass the child's environment. */
export function resolveAntigravityAcpDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const home = effectiveHome(env);
	const geminiHome = env.GEMINI_HOME?.trim();
	const base = geminiHome ? expandHome(geminiHome, home) : path.join(home, ".gemini");
	return path.join(base, "antigravity-acp");
}

/** Structural local health only. A network probe is required to call an OAuth
 * token valid; secret values are never returned or logged. `env` is the
 * environment whose credentials are inspected, not necessarily this process's. */
export function inspectAntigravityAuth(
	directory = resolveAntigravityAcpDirectory(),
	env: NodeJS.ProcessEnv = process.env,
	keychain: (authType: string | undefined) => boolean = hasKeychainCredential,
): AntigravityAuthHealth {
	const tokenPath = path.join(directory, "acp_token.json");
	const settingsPath = path.join(directory, "settings.json");
	const tokenFile = regularFile(tokenPath);
	const settingsFile = regularFile(settingsPath);
	let authType: string | undefined;
	if (settingsFile) {
		try {
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				auth?: { type?: unknown };
			};
			if (typeof settings.auth?.type === "string") authType = settings.auth.type;
		} catch {
			return { status: "corrupt", tokenFile, settingsFile };
		}
	}
	if (env.GEMINI_API_KEY) return { status: "api-key-env", authType: "gemini-api-key", tokenFile, settingsFile };
	if (tokenFile) {
		try {
			const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as { refresh_token?: unknown };
			if (typeof token.refresh_token === "string" && token.refresh_token.length > 0) {
				return {
					status: "oauth-refreshable",
					authType: authType ?? "oauth-personal",
					tokenFile,
					settingsFile,
					credentialStore: "file",
				};
			}
			return { status: "corrupt", ...(authType ? { authType } : {}), tokenFile, settingsFile };
		} catch {
			return { status: "corrupt", ...(authType ? { authType } : {}), tokenFile, settingsFile };
		}
	}
	if (authType && keychain(authType)) {
		return { status: "oauth-refreshable", authType, tokenFile, settingsFile, credentialStore: "keychain" };
	}
	if (authType) return { status: "configured-not-authenticated", authType, tokenFile, settingsFile };
	return { status: "missing", tokenFile, settingsFile };
}

export function hasAntigravityAuth(): boolean {
	const status = inspectAntigravityAuth().status;
	return status === "api-key-env" || status === "oauth-refreshable";
}

/** Local logout: removes the file token and auth choice. The runtime prefers the
 * server's ACP `logout` RPC, which also clears Keychain-stored tokens. */
export function clearAntigravityCredentials(
	directory = resolveAntigravityAcpDirectory(),
): void {
	fs.rmSync(path.join(directory, "acp_token.json"), { force: true });
	fs.rmSync(path.join(directory, "acp_business_token.json"), { force: true });
	const settingsPath = path.join(directory, "settings.json");
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		delete settings.auth;
		const temporary = `${settingsPath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, settingsPath);
	} catch {
		fs.rmSync(settingsPath, { force: true });
	}
}

function directOrWrapper(command: string, source: AntigravityLaunch["source"]): AntigravityLaunch {
	try {
		const fd = fs.openSync(command, "r");
		const bytes = Buffer.alloc(64);
		const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
		fs.closeSync(fd);
		if (bytes.subarray(0, count).toString("utf8").startsWith("#!")) {
			return { command, args: [], source };
		}
	} catch {
		// Native executable; use the server's required empty uid argument.
	}
	return { command, args: process.platform === "linux" ? ["--uid="] : [], source };
}

function executable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function regularFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The home directory a child resolves `~` and the default store against. */
function effectiveHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || os.homedir();
}

function expandHome(file: string, home = os.homedir()): string {
	return file === "~" || file.startsWith("~/") ? path.join(home, file.slice(1)) : file;
}
