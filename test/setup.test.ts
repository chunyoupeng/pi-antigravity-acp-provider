import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readBundledRuntimeManifest, latestManifestRelease } from "../src/acp/runtime-manifest.js";
import {
	adoptLegacyCurrentRelease,
	ensureAntigravityAcpReady,
	ensureManagedHarnessPatched,
	HARNESS_PATCH_MAX_TOKEN_LIMIT,
	isExpectedRuntimeIdentity,
	patchLocalHarnessBinary,
	repairRuntimeExecutablePermissions,
	resolveOfficialRelease,
	validateRuntimeArchiveEntries,
	updateAntigravityAcpRuntime,
} from "../src/acp/setup.js";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("external runtime ownership", () => {
	it("refuses explicit updates before any network request", async () => {
		const binary = path.join(temporaryDirectory(), "external-agent");
		fs.writeFileSync(binary, "external", { mode: 0o755 });
		vi.stubEnv("AGY_ACP_BIN", binary);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(updateAntigravityAcpRuntime()).rejects.toThrow("externally managed");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(fs.readFileSync(binary, "utf8")).toBe("external");
	});
});

describe("managed runtime archive validation", () => {
	const asset = latestManifestRelease(readBundledRuntimeManifest()).platforms["linux-x86_64"]!;
	const entries = [
		{ type: "File" as const, path: asset.binaryName, compressionMethod: 8, uncompressedSize: asset.binaryBytes },
		{ type: "File" as const, path: asset.harnessName, compressionMethod: 8, uncompressedSize: asset.harnessBytes },
	];

	it("accepts only the signed executable and harness layout", () => {
		expect(() => validateRuntimeArchiveEntries(entries, asset)).not.toThrow();
		expect(() =>
			validateRuntimeArchiveEntries(entries, {
				binaryName: asset.binaryName,
				harnessName: asset.harnessName,
			}),
		).not.toThrow();
	});

	it("resolves official registry releases with SHA-256 without waiting for external manifest signature", () => {
		const resolved = resolveOfficialRelease("darwin-aarch64", {
			version: "1.4.5",
			entry: {
				archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
				cmd: "./agy_acp_server.par",
				sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
			},
		});
		expect(resolved).toEqual({
			version: "1.4.5",
			platform: "darwin-aarch64",
			archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
			archiveSha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
			binaryName: "agy_acp_server.par",
			harnessName: "localharness_external",
			args: [],
		});
		expect(
			resolveOfficialRelease("darwin-aarch64", {
				version: "1.4.5",
				entry: {
					archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
					cmd: "./agy_acp_server.par",
				},
			}),
		).toBeUndefined();
	});

	it("rejects extra, traversing, or incorrectly sized members", () => {
		expect(() =>
			validateRuntimeArchiveEntries([...entries, { ...entries[0]!, path: "extra" }], asset),
		).toThrow("unexpected number");
		expect(() =>
			validateRuntimeArchiveEntries([{ ...entries[0]!, path: "../agy_acp_server.par" }, entries[1]!], asset),
		).toThrow("unexpected, unsafe");
		expect(() =>
			validateRuntimeArchiveEntries([{ ...entries[0]!, uncompressedSize: 1 }, entries[1]!], asset),
		).toThrow("unexpected, unsafe");
	});
});

describe("managed runtime process validation", () => {
	it("accepts Google's prefixed release version", () => {
		expect(
			isExpectedRuntimeIdentity(
				{
					protocolVersion: 1,
					agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.1" },
				},
				"1.1.1",
			),
		).toBe(true);
	});

	it("also accepts a bare semver but rejects other identities", () => {
		expect(
			isExpectedRuntimeIdentity(
				{ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.1.1" } },
				"1.1.1",
			),
		).toBe(true);
		expect(
			isExpectedRuntimeIdentity(
				{ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.2" } },
				"1.1.1",
			),
		).toBe(false);
		expect(
			isExpectedRuntimeIdentity(
				{ protocolVersion: 1, agentInfo: { name: "other-agent", version: "agy_acp_server_1.1.1" } },
				"1.1.1",
			),
		).toBe(false);
	});
});

describe("managed runtime migration", () => {
	it("adopts a legacy install only when its signed hash and file sizes match", () => {
		const root = temporaryDirectory();
		const current = path.join(root, "current");
		fs.mkdirSync(current);
		fs.writeFileSync(path.join(current, "agy_acp_server.par"), "server", { mode: 0o755 });
		fs.writeFileSync(path.join(current, "localharness_external"), "helper", { mode: 0o755 });
		fs.writeFileSync(
			path.join(current, "install-integrity.json"),
			JSON.stringify({ version: "1.1.1", platform: "linux-x86_64", archiveSha256: "a".repeat(64) }),
		);
		adoptLegacyCurrentRelease(root, {
			version: "1.1.1",
			platform: "linux-x86_64",
			archive: "https://dl.google.com/agy-extensions/releases/linux/test_1.1.1-linux.zip",
			archiveSha256: "a".repeat(64),
			archiveBytes: 20,
			binaryName: "agy_acp_server.par",
			binaryBytes: 6,
			harnessName: "localharness_external",
			harnessBytes: 6,
			args: ["--uid="],
		});
		expect(JSON.parse(fs.readFileSync(path.join(current, "install-integrity.json"), "utf8"))).toMatchObject({
			archiveBytes: 20,
			binaryBytes: 6,
			harnessBytes: 6,
			binaryName: "agy_acp_server.par",
		});
	});
});

describe("managed runtime executable permissions", () => {
	it("repairs the server and local harness after zip extraction", () => {
		const directory = temporaryDirectory();
		for (const name of ["agy_acp_server.par", "localharness_external"]) {
			fs.writeFileSync(path.join(directory, name), name, { mode: 0o644 });
		}

		expect(repairRuntimeExecutablePermissions(directory, "linux")).toEqual([
			"agy_acp_server.par",
			"localharness_external",
		]);
		for (const name of ["agy_acp_server.par", "localharness_external"]) {
			expect(fs.statSync(path.join(directory, name)).mode & 0o111).toBe(0o111);
		}
		expect(repairRuntimeExecutablePermissions(directory, "linux")).toEqual([]);
	});

	it("does not chmod payloads on Windows", () => {
		const directory = temporaryDirectory();
		const helper = path.join(directory, "localharness_external");
		fs.writeFileSync(helper, "helper", { mode: 0o644 });

		expect(repairRuntimeExecutablePermissions(directory, "win32")).toEqual([]);
		expect(fs.statSync(helper).mode & 0o111).toBe(0);
	});

	it("rejects a missing managed runtime payload", () => {
		const directory = temporaryDirectory();
		expect(() => repairRuntimeExecutablePermissions(directory, "linux")).toThrow(
			"Managed ACP runtime payload is missing: agy_acp_server.par",
		);
	});

	it("rejects a managed helper that is not a regular file", () => {
		const directory = temporaryDirectory();
		fs.writeFileSync(path.join(directory, "agy_acp_server.par"), "server", { mode: 0o755 });
		fs.mkdirSync(path.join(directory, "localharness_external"));
		expect(() => repairRuntimeExecutablePermissions(directory, "linux")).toThrow(
			"Managed ACP runtime payload is not a regular file",
		);
	});
});

describe("default auth profile", () => {
	it("seeds the scoped profile under GEMINI_HOME and leaves the default profile alone", async () => {
		const scopedHome = temporaryDirectory();
		const defaultSettings = path.join(os.homedir(), ".gemini", "antigravity-acp", "settings.json");
		const before = fs.existsSync(defaultSettings) ? fs.readFileSync(defaultSettings, "utf8") : undefined;
		const binary = path.join(temporaryDirectory(), "external-agent");
		fs.writeFileSync(binary, "external", { mode: 0o755 });
		vi.stubEnv("AGY_ACP_BIN", binary);
		vi.stubEnv("GEMINI_HOME", scopedHome);
		vi.stubEnv("GEMINI_API_KEY", "");
		await ensureAntigravityAcpReady();
		expect(JSON.parse(fs.readFileSync(path.join(scopedHome, "antigravity-acp", "settings.json"), "utf8"))).toMatchObject({
			auth: { type: "oauth-personal" },
		});
		const after = fs.existsSync(defaultSettings) ? fs.readFileSync(defaultSettings, "utf8") : undefined;
		expect(after).toBe(before);
	});

	it("records an API key in the scoped profile", async () => {
		const scopedHome = temporaryDirectory();
		const binary = path.join(temporaryDirectory(), "external-agent");
		fs.writeFileSync(binary, "external", { mode: 0o755 });
		vi.stubEnv("AGY_ACP_BIN", binary);
		vi.stubEnv("GEMINI_HOME", scopedHome);
		vi.stubEnv("GEMINI_API_KEY", "scoped-key");
		await ensureAntigravityAcpReady();
		expect(JSON.parse(fs.readFileSync(path.join(scopedHome, "antigravity-acp", "settings.json"), "utf8"))).toMatchObject({
			auth: { type: "gemini-api-key" },
		});
	});

	it("rejects immediately when called with an aborted signal", async () => {
		await expect(ensureAntigravityAcpReady(undefined, AbortSignal.abort())).rejects.toThrow(/cancel|abort/i);
	});
});

describe("managed harness 512K binary patch", () => {
	it("patches GetCheckpointConfig and makeCascadeConfigWithSkills* via __gopclntab and is idempotent", () => {
		const buffer = buildSyntheticMachOHarness();
		const first = patchLocalHarnessBinary(buffer);
		expect(first).toEqual({ modified: true, patched: true });

		// Verify 256,000 -> 544,000 (x4) in GetCheckpointConfig at 0x200
		expect(buffer.readUInt32LE(0x200)).toBe(0xd289a004);
		expect(buffer.readUInt32LE(0x204)).toBe(0xf2a00104);
		// Verify 140,000 -> 300,000 (x3) and 256,000 -> 544,000 (x4) in makeCascadeConfigWithSkillsRunnerAndFS at 0x210..0x21c
		expect(buffer.readUInt32LE(0x210)).toBe(0xd2927c03);
		expect(buffer.readUInt32LE(0x214)).toBe(0xf2a00083);
		expect(buffer.readUInt32LE(0x218)).toBe(0xd289a004);
		expect(buffer.readUInt32LE(0x21c)).toBe(0xf2a00104);
		// Unrelated function's 256,000 at 0x220 stays untouched
		expect(buffer.readUInt32LE(0x220)).toBe(0xd29d0004);
		expect(buffer.readUInt32LE(0x224)).toBe(0xf2a00064);

		const second = patchLocalHarnessBinary(buffer);
		expect(second).toEqual({ modified: false, patched: true });
	});

	it("updates install-integrity.json when patching an existing managed install", async () => {
		const directory = temporaryDirectory();
		const harnessPath = path.join(directory, "localharness_external");
		const serverPath = path.join(directory, "agy_acp_server.par");
		fs.writeFileSync(serverPath, "server", { mode: 0o755 });
		const synthetic = buildSyntheticMachOHarness();
		fs.writeFileSync(harnessPath, synthetic, { mode: 0o755 });
		fs.writeFileSync(
			path.join(directory, "install-integrity.json"),
			JSON.stringify({
				version: "1.4.5",
				platform: "darwin-aarch64",
				archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
				archiveSha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
				archiveBytes: 97923855,
				binaryName: "agy_acp_server.par",
				binaryBytes: 6,
				harnessName: "localharness_external",
				harnessBytes: synthetic.length,
				installedAt: "2026-10-30T02:34:00.054Z",
			}),
		);

		// On non-darwin or when codesign is unavailable for synthetic Mach-O, patchLocalHarnessBinary still works;
		// verify patchLocalHarnessBinary + ensureManagedHarnessPatched when pre-patched so codesign isn't invoked on synthetic bytes.
		patchLocalHarnessBinary(synthetic);
		fs.writeFileSync(harnessPath, synthetic, { mode: 0o755 });
		expect(await ensureManagedHarnessPatched(directory)).toBe(true);
		const record = JSON.parse(fs.readFileSync(path.join(directory, "install-integrity.json"), "utf8"));
		expect(record.harnessPatchMaxTokenLimit).toBe(HARNESS_PATCH_MAX_TOKEN_LIMIT);
		expect(record.harnessBytes).toBe(fs.statSync(harnessPath).size);
		expect(await ensureManagedHarnessPatched(directory)).toBe(false);
	});
});

function buildSyntheticMachOHarness(): Buffer {
	const buf = Buffer.alloc(0x600, 0);
	// Mach-O 64-bit arm64 header
	buf.writeUInt32LE(0xfeedfacf, 0);
	buf.writeUInt32LE(0x0100000c, 4);
	buf.writeUInt32LE(1, 16); // ncmds = 1
	// LC_SEGMENT_64 (cmd = 0x19, cmdsize = 72 + 80 = 152) at offset 32
	buf.writeUInt32LE(0x19, 32);
	buf.writeUInt32LE(152, 36);
	buf.writeUInt32LE(1, 32 + 64); // nsects = 1
	// section_64 at offset 104
	buf.write("__text", 104, "utf8");
	buf.write("__TEXT", 104 + 16, "utf8");
	buf.writeUInt32LE(0x200, 104 + 48); // text_fileoff = 0x200

	// Function 0: GetCheckpointConfig at [0x200, 0x210) -> rel [0x0, 0x10)
	buf.writeUInt32LE(0xd29d0004, 0x200); // mov x4, #0xe800 (256,000)
	buf.writeUInt32LE(0xf2a00064, 0x204); // movk x4, #0x3, lsl #16
	buf.writeUInt32LE(0xd65f03c0, 0x208); // ret

	// Function 1: makeCascadeConfigWithSkillsRunnerAndFS at [0x210, 0x220) -> rel [0x10, 0x20)
	buf.writeUInt32LE(0xd2845c03, 0x210); // mov x3, #0x22e0 (140,000)
	buf.writeUInt32LE(0xf2a00043, 0x214); // movk x3, #0x2, lsl #16
	buf.writeUInt32LE(0xd29d0004, 0x218); // mov x4, #0xe800 (256,000)
	buf.writeUInt32LE(0xf2a00064, 0x21c); // movk x4, #0x3, lsl #16

	// Function 2: unrelated function at [0x220, 0x230) -> rel [0x20, 0x30)
	buf.writeUInt32LE(0xd29d0004, 0x220);
	buf.writeUInt32LE(0xf2a00064, 0x224);

	// __gopclntab at 0x300
	const pcln = 0x300;
	Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]).copy(buf, pcln);
	buf.writeBigUInt64LE(3n, pcln + 8); // nfunc = 3
	buf.writeBigUInt64LE(0x80n, pcln + 32); // funcnameOff -> 0x380
	buf.writeBigUInt64LE(0x140n, pcln + 64); // functabOff -> 0x440

	const fnBase = pcln + 0x80;
	const name0 = "google3/cortex/utils.GetCheckpointConfig\0";
	const name1 = "google3/localharness/localagent.makeCascadeConfigWithSkillsRunnerAndFS\0";
	const name2 = "google3/other.Unrelated\0";
	buf.write(name0, fnBase, "utf8");
	const off1 = Buffer.byteLength(name0);
	buf.write(name1, fnBase + off1, "utf8");
	const off2 = off1 + Buffer.byteLength(name1);
	buf.write(name2, fnBase + off2, "utf8");

	const ftBase = pcln + 0x140;
	// 3 functab entries + 1 sentinel (4 * 8 = 32 bytes), then 3 finfo structs at ftBase + 0x30
	buf.writeUInt32LE(0x00, ftBase + 0);
	buf.writeUInt32LE(0x30, ftBase + 4);
	buf.writeUInt32LE(0x10, ftBase + 8);
	buf.writeUInt32LE(0x38, ftBase + 12);
	buf.writeUInt32LE(0x20, ftBase + 16);
	buf.writeUInt32LE(0x40, ftBase + 20);
	buf.writeUInt32LE(0x30, ftBase + 24);

	buf.writeInt32LE(0, ftBase + 0x30 + 4);
	buf.writeInt32LE(off1, ftBase + 0x38 + 4);
	buf.writeInt32LE(off2, ftBase + 0x40 + 4);
	return buf;
}

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-setup-"));
	directories.push(directory);
	return directory;
}
