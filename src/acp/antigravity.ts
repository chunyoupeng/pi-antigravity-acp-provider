import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AntigravityAcpError } from "./errors.js";
import { resolvePatchedAgyBinary, type AgyPatchStatus } from "./agy-patch.js";
export {
	AGY_DEFAULT_MAX_TOKEN_LIMIT,
	AGY_PATCH_ENABLED_ENV,
	AGY_PATCH_MAX_TOKEN_LIMIT,
	inspectAndPatchAgyBinary,
	isAgyPatchEnabled,
	readCachedAgyPatchState,
	resolvePatchedAgyBinary,
	resolvePatchedRuntimeDir,
	type AgyBinaryPatchInspection,
	type AgyPatchState,
	type AgyPatchStatus,
	type ResolvedAgyBinary,
} from "./agy-patch.js";

export const AGY_CLI_AGENT_NAME = "pi-acp-bridge";
export const AGY_CLI_NATIVE_TOOLS = [
	"read_file",
	"write_file",
	"edit_file",
	"run_command",
	"search_web",
	"generate_image",
] as const;

// Keep Antigravity's <identity> header in custom agent.md: CCPA enforces it
// server-side and returns HTTP 429 RESOURCE_EXHAUSTED when it is omitted.
const AGY_CLI_AGENT_MARKDOWN = `---
name: ${AGY_CLI_AGENT_NAME}
description: Minimal Antigravity ACP agent for Pi (native file, shell, web search, and image tools plus Pi MCP bridge)
mainAgent: true
excludeDefaultComponents: true
tools:
${AGY_CLI_NATIVE_TOOLS.map((tool) => `  - ${tool}`).join("\n")}
---
<identity>
You are Antigravity, a powerful agentic AI assistant designed by the Google Deepmind team.
You are working with a USER to solve their task.
The USER will send you requests, which you must always prioritize addressing.
</identity>
`;

export interface AntigravityLaunch {
	command: string;
	args: string[];
	source: "env" | "user-bin" | "path";
	officialCommand?: string;
	patchStatus?: AgyPatchStatus;
}

export interface AntigravityLaunchOptions {
	dangerouslySkipPermissions?: boolean;
	env?: NodeJS.ProcessEnv;
}

export function resolveAgyCliAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const home = effectiveHome(env);
	const geminiHome = env.GEMINI_HOME?.trim();
	const base = geminiHome ? expandHome(geminiHome, home) : path.join(home, ".gemini");
	return path.join(base, "antigravity-cli");
}

/** Ensures the minimal custom agent definition exists in `agy`'s global agents
 * directory so `agy acp --agent pi-acp-bridge` disables default prompts/tools
 * while keeping native file/shell tools and Pi's HTTP MCP bridge. */
export function ensureAgyCliCustomAgent(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = path.join(resolveAgyCliAppDataDir(env), "agents", AGY_CLI_AGENT_NAME);
	const agentFile = path.join(agentDir, "agent.md");
	try {
		if (fs.readFileSync(agentFile, "utf8") === AGY_CLI_AGENT_MARKDOWN) return agentFile;
	} catch {
		// Missing or unreadable; write below.
	}
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temporary = `${agentFile}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, AGY_CLI_AGENT_MARKDOWN, { mode: 0o600 });
	fs.renameSync(temporary, agentFile);
	return agentFile;
}

function buildAgyCliLaunch(
	officialCommand: string,
	source: AntigravityLaunch["source"],
	options: AntigravityLaunchOptions,
): AntigravityLaunch {
	ensureAgyCliCustomAgent(options.env);
	const resolved = resolvePatchedAgyBinary(officialCommand, {
		...(options.env !== undefined ? { env: options.env } : {}),
	});
	const args = [
		"acp",
		"--process-per-session",
		"--agent",
		AGY_CLI_AGENT_NAME,
		"--disable-telemetry",
	];
	if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
	return {
		command: resolved.command,
		args,
		source,
		...(resolved.status === "patched" ? { officialCommand, patchStatus: resolved.status } : {}),
	};
}

export function resolveAntigravityAcpLaunch(options: AntigravityLaunchOptions = {}): AntigravityLaunch {
	const procEnv = options.env ?? process.env;
	const home = effectiveHome(procEnv);
	const env = procEnv.AGY_ACP_BIN?.trim();
	if (env) {
		const command = expandHome(env, home);
		if (executable(command)) return buildAgyCliLaunch(command, "env", options);
	}

	const agyNames = process.platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
	for (const name of agyNames) {
		const userAgy = path.join(home, ".local", "bin", name);
		if (executable(userAgy)) return buildAgyCliLaunch(userAgy, "user-bin", options);
	}
	for (const directory of (procEnv.PATH ?? procEnv.Path ?? "").split(path.delimiter)) {
		if (!directory) continue;
		for (const name of agyNames) {
			const candidate = path.join(directory, name);
			if (executable(candidate)) return buildAgyCliLaunch(candidate, "path", options);
		}
	}

	throw new AntigravityAcpError(
		"spawn",
		"Google Antigravity CLI (agy) is not installed. Install agy or set AGY_ACP_BIN.",
	);
}

export type AntigravityAuthStatus =
	| "api-key-env"
	| "oauth-refreshable"
	| "missing";

export interface AntigravityAuthHealth {
	status: AntigravityAuthStatus;
	authType?: string;
	credentialStore?: "keychain";
}

const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const SECURITY_CLI = "/usr/bin/security";

/** Checks entry presence only; `find-generic-password` without -w/-g never
 * reads the secret, so it cannot trigger a Keychain access prompt. */
export function hasKeychainCredential(): boolean {
	if (process.platform !== "darwin" || process.env.VITEST) return false;
	try {
		execFileSync(SECURITY_CLI, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
			stdio: "ignore",
			timeout: 3_000,
		});
		return true;
	} catch {
		return false;
	}
}

export function clearKeychainCredentials(): void {
	if (process.platform !== "darwin") return;
	try {
		execFileSync(SECURITY_CLI, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
			stdio: "ignore",
			timeout: 3_000,
		});
	} catch {
		// Absent entry is already logged out.
	}
}

/** Structural local health only. A network probe is required to call an OAuth
 * token valid; secret values are never returned or logged. */
export function inspectAntigravityAuth(
	env: NodeJS.ProcessEnv = process.env,
	keychain: () => boolean = hasKeychainCredential,
): AntigravityAuthHealth {
	if (env.GEMINI_API_KEY) return { status: "api-key-env", authType: "gemini-api-key" };
	if (keychain()) {
		return {
			status: "oauth-refreshable",
			authType: "oauth-personal",
			credentialStore: "keychain",
		};
	}
	return { status: "missing" };
}

export function hasAntigravityAuth(): boolean {
	const status = inspectAntigravityAuth().status;
	return status === "api-key-env" || status === "oauth-refreshable";
}

function executable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function effectiveHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || os.homedir();
}

function expandHome(file: string, home = os.homedir()): string {
	return file === "~" || file.startsWith("~/") ? path.join(home, file.slice(1)) : file;
}
