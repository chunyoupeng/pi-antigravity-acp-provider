import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readBundledRuntimeManifest, latestManifestRelease } from "../src/acp/runtime-manifest.js";
import {
	adoptLegacyCurrentRelease,
	ensureAntigravityAcpReady,
	isExpectedRuntimeIdentity,
	repairRuntimeExecutablePermissions,
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
});

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-setup-"));
	directories.push(directory);
	return directory;
}
