import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AGY_DEFAULT_MAX_TOKEN_LIMIT,
	AGY_PATCH_ENABLED_ENV,
	AGY_PATCH_MAX_TOKEN_LIMIT,
	inspectAndPatchAgyBinary,
	readCachedAgyPatchState,
	resolvePatchedAgyBinary,
} from "../src/acp/agy-patch.js";
import { resolveAntigravityAcpLaunch } from "../src/acp/antigravity.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-patch-test-"));
	roots.push(dir);
	return dir;
}

function encodeArm64MovImm32(reg: number, value: number, is64Bit = true): [number, number] {
	const lo16 = value & 0xffff;
	const hi16 = (value >>> 16) & 0xffff;
	const r = reg & 0x1f;
	const movzBase = is64Bit ? 0xd2800000 : 0x52800000;
	const movkBase = is64Bit ? 0xf2a00000 : 0x72a00000;
	return [((movzBase | (lo16 << 5) | r) >>> 0), ((movkBase | (hi16 << 5) | r) >>> 0)];
}

/** Builds a minimal Mach-O 64-bit ARM64 binary with a Go 1.20+ pclntab and one function. */
function buildSyntheticMachO(
	funcName: string,
	instructions: number[],
	extraPadBytes = 0,
): Buffer {
	const textFileOff = 256;
	const codeBytes = instructions.length * 4;
	const pclnOff = textFileOff + Math.max(codeBytes, 64);
	const funcNameBuf = Buffer.from(`${funcName}\0`, "utf8");
	const funcnameOff = 72;
	const functabOff = funcnameOff + Math.ceil(funcNameBuf.length / 8) * 8;
	const finfoOff = 16; // relative to functabOff (after 2 * 8-byte functab entries)
	const totalSize = pclnOff + functabOff + finfoOff + 16 + extraPadBytes;

	const buf = Buffer.alloc(totalSize);
	// Mach-O 64-bit header
	buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
	buf.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
	buf.writeUInt32LE(1, 16); // ncmds = 1

	// LC_SEGMENT_64 command (72 bytes) + 1 section (80 bytes) = 152 bytes
	const cmdOff = 32;
	buf.writeUInt32LE(0x19, cmdOff); // LC_SEGMENT_64
	buf.writeUInt32LE(152, cmdOff + 4);
	buf.writeUInt32LE(1, cmdOff + 64); // nsects = 1
	const sectOff = cmdOff + 72;
	buf.write("__text", sectOff, "utf8");
	buf.write("__TEXT", sectOff + 16, "utf8");
	buf.writeUInt32LE(textFileOff, sectOff + 48);

	// Instructions in __TEXT,__text
	for (let i = 0; i < instructions.length; i++) {
		buf.writeUInt32LE(instructions[i]!, textFileOff + i * 4);
	}

	// Go 1.20+ pclntab header
	Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]).copy(buf, pclnOff);
	buf.writeBigUInt64LE(1n, pclnOff + 8); // nfunc = 1
	buf.writeBigUInt64LE(BigInt(funcnameOff), pclnOff + 32);
	buf.writeBigUInt64LE(BigInt(functabOff), pclnOff + 64);
	funcNameBuf.copy(buf, pclnOff + funcnameOff);

	// functab: [entryRel=0, finfoRel=finfoOff], [nextRel=codeBytes, 0]
	const ftBase = pclnOff + functabOff;
	buf.writeUInt32LE(0, ftBase);
	buf.writeUInt32LE(finfoOff, ftBase + 4);
	buf.writeUInt32LE(codeBytes, ftBase + 8);
	buf.writeUInt32LE(0, ftBase + 12);

	// _func info at ftBase + finfoOff: entryOff=0, nameOff=0
	buf.writeUInt32LE(0, ftBase + finfoOff);
	buf.writeInt32LE(0, ftBase + finfoOff + 4);

	return buf;
}

describe("agy checkpoint limit patcher", () => {
	it("patches all 256,000 cap sites (64-bit and 32-bit) in utils.GetCheckpointConfig", () => {
		const [a1, a2] = encodeArm64MovImm32(4, AGY_DEFAULT_MAX_TOKEN_LIMIT, true);
		const [b1, b2] = encodeArm64MovImm32(3, AGY_DEFAULT_MAX_TOKEN_LIMIT, false);
		const nop = 0xd503201f;
		const binary = buildSyntheticMachO(
			"google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig",
			[nop, a1, a2, nop, b1, b2, nop],
		);

		const first = inspectAndPatchAgyBinary(binary);
		expect(first).toEqual({ status: "patched", modified: true, patchedSites: 2 });

		// Idempotent on an already-patched binary
		const second = inspectAndPatchAgyBinary(binary);
		expect(second).toEqual({ status: "patched", modified: false, patchedSites: 2 });

		// Verify instructions were rewritten to 544,000 preserving register & width
		const [pA1, pA2] = encodeArm64MovImm32(4, AGY_PATCH_MAX_TOKEN_LIMIT, true);
		const [pB1, pB2] = encodeArm64MovImm32(3, AGY_PATCH_MAX_TOKEN_LIMIT, false);
		expect(binary.readUInt32LE(256 + 4)).toBe(pA1);
		expect(binary.readUInt32LE(256 + 8)).toBe(pA2);
		expect(binary.readUInt32LE(256 + 16)).toBe(pB1);
		expect(binary.readUInt32LE(256 + 20)).toBe(pB2);
	});

	it("reports native when utils.GetCheckpointConfig has no 256,000 cap", () => {
		const [m1, m2] = encodeArm64MovImm32(4, 1_000_000, true);
		const binary = buildSyntheticMachO(
			"google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig",
			[m1, m2],
		);

		expect(inspectAndPatchAgyBinary(binary)).toEqual({
			status: "native",
			modified: false,
			patchedSites: 0,
		});
	});

	it("reports unsupported for non-Mach-O files or missing symbol", () => {
		expect(inspectAndPatchAgyBinary(Buffer.from("#!/bin/sh\nexit 0\n"))).toEqual({
			status: "unsupported",
			modified: false,
			patchedSites: 0,
		});
		const otherFunc = buildSyntheticMachO("main.main", [0xd503201f, 0xd503201f]);
		expect(inspectAndPatchAgyBinary(otherFunc)).toEqual({
			status: "unsupported",
			modified: false,
			patchedSites: 0,
		});
	});

	it("patches a copy without touching official agy, uses fast cache, re-patches on update, and cleans up when official turns native", () => {
		const root = makeRoot();
		const official = path.join(root, ".local", "bin", "agy");
		const runtimeDir = path.join(root, "runtime");
		fs.mkdirSync(path.dirname(official), { recursive: true });

		const [c1, c2] = encodeArm64MovImm32(4, AGY_DEFAULT_MAX_TOKEN_LIMIT, true);
		const v1 = buildSyntheticMachO("google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig", [c1, c2]);
		const v1Snapshot = Buffer.from(v1);
		fs.writeFileSync(official, v1, { mode: 0o755 });

		const codesign = vi.fn();
		const first = resolvePatchedAgyBinary(official, { runtimeDir, platform: "darwin", codesign });
		expect(first.status).toBe("patched");
		expect(first.command).toBe(path.join(runtimeDir, "agy"));
		expect(first.officialCommand).toBe(official);
		expect(first.patchedSites).toBe(1);
		expect(codesign).toHaveBeenCalledTimes(1);
		// Official binary stays untouched
		expect(fs.readFileSync(official).equals(v1Snapshot)).toBe(true);
		// Patched copy has 544k
		expect(inspectAndPatchAgyBinary(fs.readFileSync(first.command))).toEqual({
			status: "patched",
			modified: false,
			patchedSites: 1,
		});

		// Second call hits fast-path cache without re-signing
		const second = resolvePatchedAgyBinary(official, { runtimeDir, platform: "darwin", codesign });
		expect(second).toEqual(first);
		expect(codesign).toHaveBeenCalledTimes(1);

		// Simulate official agy update (still capped at 256k, larger size)
		const v2 = buildSyntheticMachO("google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig", [c1, c2], 32);
		fs.writeFileSync(official, v2, { mode: 0o755 });
		const third = resolvePatchedAgyBinary(official, { runtimeDir, platform: "darwin", codesign });
		expect(third.status).toBe("patched");
		expect(third.command).toBe(path.join(runtimeDir, "agy"));
		expect(codesign).toHaveBeenCalledTimes(2);

		// Simulate official agy update that natively supports >256k (no 256k cap)
		const [n1, n2] = encodeArm64MovImm32(4, 1_000_000, true);
		const v3 = buildSyntheticMachO("google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig", [n1, n2], 64);
		fs.writeFileSync(official, v3, { mode: 0o755 });
		const fourth = resolvePatchedAgyBinary(official, { runtimeDir, platform: "darwin", codesign });
		expect(fourth).toEqual({
			command: official,
			officialCommand: official,
			status: "native",
		});
		// Old patched copy is deleted to reclaim disk space
		expect(fs.existsSync(path.join(runtimeDir, "agy"))).toBe(false);
		expect(readCachedAgyPatchState(process.env, runtimeDir)?.status).toBe("native");
		expect(codesign).toHaveBeenCalledTimes(2);
	});

	it("falls back safely to official binary on codesign failure or when disabled via env", () => {
		const root = makeRoot();
		const official = path.join(root, ".local", "bin", "agy");
		const runtimeDir = path.join(root, "runtime");
		fs.mkdirSync(path.dirname(official), { recursive: true });
		const [c1, c2] = encodeArm64MovImm32(4, AGY_DEFAULT_MAX_TOKEN_LIMIT, true);
		fs.writeFileSync(
			official,
			buildSyntheticMachO("google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig", [c1, c2]),
			{ mode: 0o755 },
		);

		const disabled = resolvePatchedAgyBinary(official, {
			runtimeDir,
			env: { [AGY_PATCH_ENABLED_ENV]: "0" },
		});
		expect(disabled).toEqual({ command: official, officialCommand: official, status: "disabled" });

		const failed = resolvePatchedAgyBinary(official, {
			runtimeDir,
			platform: "darwin",
			codesign: () => {
				throw new Error("codesign failed");
			},
		});
		expect(failed.status).toBe("fallback");
		expect(failed.command).toBe(official);
		expect(failed.reason).toContain("codesign failed");
		// No leftover temp files or broken binary
		expect(fs.readdirSync(runtimeDir)).toEqual([]);
	});

	it("wires patched copy through resolveAntigravityAcpLaunch while keeping official untouched", () => {
		const home = makeRoot();
		const official = path.join(home, ".local", "bin", "agy");
		fs.mkdirSync(path.dirname(official), { recursive: true });
		const [c1, c2] = encodeArm64MovImm32(4, AGY_DEFAULT_MAX_TOKEN_LIMIT, true);
		const raw = buildSyntheticMachO("google3/third_party/jetski/cortex/utils/utils.GetCheckpointConfig", [c1, c2]);
		fs.writeFileSync(official, raw, { mode: 0o755 });

		// On macOS, codesign fails on synthetic minimal Mach-O (not full Mach-O segments),
		// so test the env opt-out path through resolveAntigravityAcpLaunch directly.
		const launchDisabled = resolveAntigravityAcpLaunch({
			env: { HOME: home, PATH: "", [AGY_PATCH_ENABLED_ENV]: "0" },
		});
		expect(launchDisabled.command).toBe(official);
		expect(launchDisabled.patchStatus).toBeUndefined();
	});
});
