import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGY_PATCH_ENABLED_ENV = "PI_ANTIGRAVITY_PATCH_AGY";
export const AGY_DEFAULT_MAX_TOKEN_LIMIT = 256_000;
export const AGY_PATCH_MAX_TOKEN_LIMIT = 544_000;

export type AgyPatchStatus = "patched" | "native" | "unsupported" | "disabled" | "fallback";

export interface AgyBinaryPatchInspection {
	status: "patched" | "native" | "unsupported";
	modified: boolean;
	patchedSites: number;
}

export interface AgyPatchState {
	sourcePath: string;
	sourceSize: number;
	sourceMtimeMs: number;
	targetMaxTokenLimit: number;
	status: "patched" | "native" | "unsupported";
	patchedSites: number;
	checkedAt: string;
}

export interface ResolvedAgyBinary {
	command: string;
	officialCommand: string;
	status: AgyPatchStatus;
	patchedSites?: number;
	maxTokenLimit?: number;
	reason?: string;
}

export interface ResolvePatchedAgyOptions {
	env?: NodeJS.ProcessEnv;
	runtimeDir?: string;
	targetMaxTokenLimit?: number;
	platform?: NodeJS.Platform;
	codesign?: (binaryPath: string) => void;
}

const CODESIGN_CLI = "/usr/bin/codesign";
const STATE_FILE_NAME = "patch-state.json";

export function isAgyPatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[AGY_PATCH_ENABLED_ENV]?.trim().toLowerCase();
	if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
	return true;
}

export function resolvePatchedRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME?.trim() || os.homedir();
	const custom = env.PI_CODING_AGENT_DIR?.trim();
	const piAgentDir = custom
		? (custom === "~" || custom.startsWith("~/") ? path.join(home, custom.slice(1)) : custom)
		: path.join(home, ".pi", "agent");
	return path.join(piAgentDir, "antigravity-acp-provider", "runtime");
}

function encodeArm64MovImm32(reg: number, value: number, is64Bit: boolean): [number, number] {
	const lo16 = value & 0xffff;
	const hi16 = (value >>> 16) & 0xffff;
	const r = reg & 0x1f;
	const movzBase = is64Bit ? 0xd2800000 : 0x52800000;
	const movkBase = is64Bit ? 0xf2a00000 : 0x72a00000;
	return [((movzBase | (lo16 << 5) | r) >>> 0), ((movkBase | (hi16 << 5) | r) >>> 0)];
}

function matchArm64MovImm32(ins1: number, ins2: number, value: number): { reg: number; is64Bit: boolean } | undefined {
	const reg = ins1 & 0x1f;
	if ((ins2 & 0x1f) !== reg) return undefined;
	for (const is64Bit of [true, false]) {
		const [e1, e2] = encodeArm64MovImm32(reg, value, is64Bit);
		if (ins1 === e1 && ins2 === e2) return { reg, is64Bit };
	}
	return undefined;
}

/**
 * Inspects a Mach-O arm64 Go `agy` binary's `utils.GetCheckpointConfig` function
 * and patches its hardcoded 256,000 token cap to `targetMaxTokenLimit` in place.
 *
 * Returns:
 * - `"patched"`: 256,000 cap found and replaced (or already equal to `targetMaxTokenLimit`).
 * - `"native"`: `utils.GetCheckpointConfig` found with no 256,000 cap (official binary
 *   natively allows >256K without patching).
 * - `"unsupported"`: non-Mach-O-arm64 binary, missing Go pclntab, or symbol refactored.
 */
export function inspectAndPatchAgyBinary(
	buffer: Buffer,
	targetMaxTokenLimit = AGY_PATCH_MAX_TOKEN_LIMIT,
): AgyBinaryPatchInspection {
	// Mach-O 64-bit arm64 magic (0xfeedfacf) and CPU_TYPE_ARM64 (0x0100000c)
	if (
		buffer.length < 32 ||
		buffer.readUInt32LE(0) !== 0xfeedfacf ||
		buffer.readUInt32LE(4) !== 0x0100000c
	) {
		return { status: "unsupported", modified: false, patchedSites: 0 };
	}

	const ncmds = buffer.readUInt32LE(16);
	let cmdOff = 32;
	let textFileOff = -1;
	for (let i = 0; i < ncmds && cmdOff + 8 <= buffer.length; i++) {
		const cmd = buffer.readUInt32LE(cmdOff);
		const cmdsize = buffer.readUInt32LE(cmdOff + 4);
		if (cmdsize < 8 || cmdOff + cmdsize > buffer.length) break;
		if (cmd === 0x19 && cmdOff + 72 <= buffer.length) {
			const nsects = buffer.readUInt32LE(cmdOff + 64);
			let sectOff = cmdOff + 72;
			for (let s = 0; s < nsects && sectOff + 80 <= cmdOff + cmdsize; s++) {
				const sectname = buffer.subarray(sectOff, sectOff + 16).toString("utf8").replace(/\0+$/u, "");
				const segname = buffer.subarray(sectOff + 16, sectOff + 32).toString("utf8").replace(/\0+$/u, "");
				if (segname === "__TEXT" && sectname === "__text") {
					textFileOff = buffer.readUInt32LE(sectOff + 48);
				}
				sectOff += 80;
			}
		}
		cmdOff += cmdsize;
	}
	if (textFileOff < 0 || textFileOff >= buffer.length) {
		return { status: "unsupported", modified: false, patchedSites: 0 };
	}

	const pclnMagic = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]);
	let pcln = -1;
	let searchFrom = 0;
	while (searchFrom < buffer.length) {
		const idx = buffer.indexOf(pclnMagic, searchFrom);
		if (idx === -1 || idx + 72 > buffer.length) break;
		const nfunc = Number(buffer.readBigUInt64LE(idx + 8));
		if (nfunc > 0 && nfunc < 1_000_000) {
			pcln = idx;
			break;
		}
		searchFrom = idx + 1;
	}
	if (pcln < 0) return { status: "unsupported", modified: false, patchedSites: 0 };

	const nfunc = Number(buffer.readBigUInt64LE(pcln + 8));
	const funcnameOff = Number(buffer.readBigUInt64LE(pcln + 32));
	const functabOff = Number(buffer.readBigUInt64LE(pcln + 64));
	const fnBase = pcln + funcnameOff;
	const ftBase = pcln + functabOff;
	if (fnBase < 0 || ftBase < 0 || ftBase + (nfunc + 1) * 8 > buffer.length) {
		return { status: "unsupported", modified: false, patchedSites: 0 };
	}

	let foundCheckpointConfig = false;
	let modifiedCount = 0;
	let matchedCount = 0;
	for (let i = 0; i < nfunc; i++) {
		const entryOff = ftBase + i * 8;
		const entryRel = buffer.readUInt32LE(entryOff);
		const finfoRel = buffer.readUInt32LE(entryOff + 4);
		const nextRel = buffer.readUInt32LE(entryOff + 8);
		if (ftBase + finfoRel + 8 > buffer.length) continue;
		const nameRel = buffer.readInt32LE(ftBase + finfoRel + 4);
		const nameStart = fnBase + nameRel;
		if (nameStart < 0 || nameStart >= buffer.length) continue;
		const nameEnd = buffer.indexOf(0, nameStart);
		if (nameEnd === -1) continue;
		const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
		if (!name.endsWith("utils.GetCheckpointConfig")) continue;

		foundCheckpointConfig = true;
		const start = textFileOff + entryRel;
		const end = Math.min(textFileOff + nextRel, buffer.length);
		for (let off = start; off <= end - 8; off += 4) {
			const ins1 = buffer.readUInt32LE(off);
			const ins2 = buffer.readUInt32LE(off + 4);
			const capMatch = matchArm64MovImm32(ins1, ins2, AGY_DEFAULT_MAX_TOKEN_LIMIT);
			if (capMatch) {
				const [patch1, patch2] = encodeArm64MovImm32(capMatch.reg, targetMaxTokenLimit, capMatch.is64Bit);
				buffer.writeUInt32LE(patch1, off);
				buffer.writeUInt32LE(patch2, off + 4);
				modifiedCount++;
				matchedCount++;
				continue;
			}
			if (matchArm64MovImm32(ins1, ins2, targetMaxTokenLimit)) {
				matchedCount++;
			}
		}
	}

	if (!foundCheckpointConfig) {
		return { status: "unsupported", modified: false, patchedSites: 0 };
	}
	if (matchedCount > 0) {
		return { status: "patched", modified: modifiedCount > 0, patchedSites: matchedCount };
	}
	return { status: "native", modified: false, patchedSites: 0 };
}

/**
 * Resolves the executable path to run for `agy acp` without ever modifying the
 * official `agy` binary:
 * - Fast path: compares `realpath + size + mtimeMs` against cached `patch-state.json`.
 * - On first run or after official `agy` updates: inspects the official binary.
 *   - If it still hard-caps `utils.GetCheckpointConfig` at 256K: copies into the
 *     provider's runtime directory, patches to 544K, ad-hoc codesigns on macOS,
 *     and atomically publishes the copy.
 *   - If the official binary already removed the 256K cap (`"native"`): removes
 *     any stale patched copy and launches the official binary directly.
 *   - On unsupported platforms/binaries or signing failures: safely falls back
 *     to the official binary.
 */
export function resolvePatchedAgyBinary(
	officialCommand: string,
	options: ResolvePatchedAgyOptions = {},
): ResolvedAgyBinary {
	const env = options.env ?? process.env;
	if (!isAgyPatchEnabled(env)) {
		return { command: officialCommand, officialCommand, status: "disabled" };
	}

	const platform = options.platform ?? process.platform;
	const targetLimit = options.targetMaxTokenLimit ?? AGY_PATCH_MAX_TOKEN_LIMIT;
	const runtimeDir = options.runtimeDir ?? resolvePatchedRuntimeDir(env);
	const patchedPath = path.join(runtimeDir, path.basename(officialCommand));
	const statePath = path.join(runtimeDir, STATE_FILE_NAME);

	let realSource: string;
	let stat: fs.Stats;
	try {
		realSource = fs.realpathSync(officialCommand);
		stat = fs.statSync(realSource);
	} catch (error) {
		return {
			command: officialCommand,
			officialCommand,
			status: "fallback",
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	const cached = readPatchState(statePath);
	if (
		cached &&
		cached.sourcePath === realSource &&
		cached.sourceSize === stat.size &&
		cached.sourceMtimeMs === stat.mtimeMs &&
		cached.targetMaxTokenLimit === targetLimit
	) {
		if (cached.status === "patched") {
			if (isExecutableFile(patchedPath)) {
				return {
					command: patchedPath,
					officialCommand,
					status: "patched",
					patchedSites: cached.patchedSites,
					maxTokenLimit: targetLimit,
				};
			}
			// Cached copy was removed externally; regenerate below.
		} else {
			return { command: officialCommand, officialCommand, status: cached.status };
		}
	}

	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(realSource);
	} catch (error) {
		return {
			command: officialCommand,
			officialCommand,
			status: "fallback",
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	const inspection = inspectAndPatchAgyBinary(buffer, targetLimit);
	const checkedAt = new Date().toISOString();

	if (inspection.status === "patched") {
		let temporary: string | undefined;
		try {
			fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
			temporary = `${patchedPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
			fs.writeFileSync(temporary, buffer, { mode: 0o755 });
			fs.chmodSync(temporary, 0o755);
			if (platform === "darwin") {
				const sign = options.codesign ?? defaultCodesign;
				sign(temporary);
			}
			fs.renameSync(temporary, patchedPath);
			temporary = undefined;
			writePatchState(statePath, {
				sourcePath: realSource,
				sourceSize: stat.size,
				sourceMtimeMs: stat.mtimeMs,
				targetMaxTokenLimit: targetLimit,
				status: "patched",
				patchedSites: inspection.patchedSites,
				checkedAt,
			});
			return {
				command: patchedPath,
				officialCommand,
				status: "patched",
				patchedSites: inspection.patchedSites,
				maxTokenLimit: targetLimit,
			};
		} catch (error) {
			if (temporary) fs.rmSync(temporary, { force: true });
			return {
				command: officialCommand,
				officialCommand,
				status: "fallback",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// Official binary natively supports >256K or is unsupported on this host:
	// clean up any stale patched copy and run the official binary directly.
	try {
		fs.rmSync(patchedPath, { force: true });
		if (fs.existsSync(runtimeDir) || inspection.status === "native") {
			fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
			writePatchState(statePath, {
				sourcePath: realSource,
				sourceSize: stat.size,
				sourceMtimeMs: stat.mtimeMs,
				targetMaxTokenLimit: targetLimit,
				status: inspection.status,
				patchedSites: 0,
				checkedAt,
			});
		}
	} catch {
		// Best-effort cleanup and state persistence.
	}

	return {
		command: officialCommand,
		officialCommand,
		status: inspection.status,
	};
}

/** Reads the cached patch status without triggering a patch or copying files. */
export function readCachedAgyPatchState(
	env: NodeJS.ProcessEnv = process.env,
	runtimeDir = resolvePatchedRuntimeDir(env),
): AgyPatchState | undefined {
	return readPatchState(path.join(runtimeDir, STATE_FILE_NAME));
}

function defaultCodesign(binaryPath: string): void {
	execFileSync(CODESIGN_CLI, ["--force", "--sign", "-", binaryPath], {
		stdio: "pipe",
		timeout: 30_000,
	});
}

function readPatchState(statePath: string): AgyPatchState | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<AgyPatchState>;
		if (
			typeof parsed.sourcePath === "string" &&
			typeof parsed.sourceSize === "number" &&
			typeof parsed.sourceMtimeMs === "number" &&
			typeof parsed.targetMaxTokenLimit === "number" &&
			(parsed.status === "patched" || parsed.status === "native" || parsed.status === "unsupported") &&
			typeof parsed.patchedSites === "number" &&
			typeof parsed.checkedAt === "string"
		) {
			return parsed as AgyPatchState;
		}
	} catch {
		// Missing or malformed state file triggers a fresh check.
	}
	return undefined;
}

function writePatchState(statePath: string, state: AgyPatchState): void {
	const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, statePath);
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
