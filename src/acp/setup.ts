import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Open, type File as ZipFile } from "unzipper";

import { loadConfig, type RuntimeUpdateMode } from "../config.js";
import { resolveAntigravityAcpDirectory, resolveAntigravityAcpLaunch, type AntigravityLaunch } from "./antigravity.js";
import { AntigravityAcpConnection } from "./connection.js";
import { abortError, AntigravityAcpError } from "./errors.js";
import { recordRuntimeUpdateNotice } from "./update-notice.js";
import {
	compareRuntimeVersions,
	isRuntimePlatform,
	latestManifestRelease,
	parseTrustedRuntimeManifest,
	readBundledRuntimeManifest,
	RUNTIME_MANIFEST_URL,
	validateGoogleArchiveUrl,
	type RuntimeRelease,
	type RuntimeReleaseAsset,
	type TrustedRuntimeManifest,
} from "./runtime-manifest.js";

const execFileAsync = promisify(execFile);
const REGISTRY_URL =
	"https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";
const INSTALL_TIMEOUT_MS = 45 * 60_000;
const VALIDATION_TIMEOUT_MS = 90_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const LOCK_POLL_MS = 250;
const LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 5 * 60_000;
const PARALLEL_RANGE_BYTES = 1024 * 1024;
const PARALLEL_RANGE_CONCURRENCY = 16;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
let inFlight: Promise<void> | undefined;
let backgroundUpdate: Promise<void> | undefined;

interface RegistryEntry {
	archive: string;
	cmd?: string;
	args?: string[];
	sha256?: string;
}

export interface OfficialRegistryRelease {
	version: string;
	entry: RegistryEntry;
}

export interface ResolvedRuntimeRelease
	extends Omit<RuntimeReleaseAsset, "archiveBytes" | "binaryBytes" | "harnessBytes"> {
	version: string;
	platform: string;
	archiveBytes?: number;
	binaryBytes?: number;
	harnessBytes?: number;
}

interface CachedManifest {
	checkedAt: number;
	manifest: TrustedRuntimeManifest;
}

interface CachedOfficialRelease {
	checkedAt: number;
	release: OfficialRegistryRelease;
}

interface RuntimeInstallRecord {
	version: string;
	platform: string;
	archive: string;
	archiveSha256: string;
	archiveBytes: number;
	binaryName: string;
	binaryBytes: number;
	harnessName: string;
	harnessBytes: number;
	installedAt: string;
}

export interface RuntimeSetupStatus {
	installed: boolean;
	launch?: AntigravityLaunch;
	installedVersion?: string;
	approvedVersion: string;
	updateAvailable: boolean;
	updateMode: RuntimeUpdateMode;
	platform: string;
	musl: boolean;
}

export interface RuntimeUpdateStatus {
	installedVersion?: string;
	latestVersion: string;
	approvedVersion: string;
	updateAvailable: boolean;
	approvalPending: boolean;
	managed: boolean;
	launch?: AntigravityLaunch;
}

export function inspectRuntimeSetup(): RuntimeSetupStatus {
	let launch: AntigravityLaunch | undefined;
	try {
		launch = resolveAntigravityAcpLaunch();
	} catch {
		// Not installed.
	}
	const key = platformKey();
	const installedVersion = launch?.source === "managed" ? readInstallRecord(path.dirname(launch.command))?.version : undefined;
	const manifestVersion = latestManifestRelease(readCachedManifest()?.manifest ?? readBundledRuntimeManifest()).version;
	const cachedOfficial = readCachedOfficialRelease(key)?.release;
	const officialRelease = cachedOfficial ? resolveOfficialRelease(key, cachedOfficial) : undefined;
	const approvedVersion =
		officialRelease && compareRuntimeVersions(officialRelease.version, manifestVersion) > 0
			? officialRelease.version
			: manifestVersion;
	return {
		installed: launch !== undefined,
		...(launch ? { launch } : {}),
		...(installedVersion ? { installedVersion } : {}),
		approvedVersion,
		updateAvailable: installedVersion !== undefined && compareRuntimeVersions(installedVersion, approvedVersion) < 0,
		updateMode: loadConfig().runtimeUpdates,
		platform: key,
		musl: isMuslLinux(),
	};
}

export function ensureAntigravityAcpReady(
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	inFlight ??= ensureOnce(onProgress).finally(() => {
		inFlight = undefined;
	});
	return raceSignal(inFlight, signal);
}

export async function checkAntigravityAcpUpdate(force = false): Promise<RuntimeUpdateStatus> {
	const key = platformKey();
	const { release, officialVersion } = await resolveLatestRelease(key, force);
	let launch: AntigravityLaunch | undefined;
	try {
		launch = resolveAntigravityAcpLaunch();
	} catch {
		// Missing runtimes are install candidates.
	}
	const installedVersion = launch?.source === "managed" ? readInstallRecord(path.dirname(launch.command))?.version : undefined;
	return {
		...(installedVersion ? { installedVersion } : {}),
		latestVersion: officialVersion,
		approvedVersion: release.version,
		updateAvailable: installedVersion === undefined || compareRuntimeVersions(installedVersion, release.version) < 0,
		approvalPending: compareRuntimeVersions(release.version, officialVersion) < 0,
		managed: launch === undefined || launch.source === "managed",
		...(launch ? { launch } : {}),
	};
}

export async function updateAntigravityAcpRuntime(
	onProgress?: (message: string) => void,
): Promise<{ version: string; changed: boolean; binary: string }> {
	configureDefaultAuth();
	const selected = inspectRuntimeSetup().launch;
	if (selected && selected.source !== "managed") {
		throw new AntigravityAcpError(
			"spawn",
			"The selected Antigravity ACP runtime is externally managed. Update it with its own installer; no managed runtime was installed.",
		);
	}
	const { release, officialVersion } = await resolveLatestRelease(platformKey(), true);
	if (compareRuntimeVersions(release.version, officialVersion) < 0) {
		throw new AntigravityAcpError(
			"spawn",
			`Antigravity ACP ${officialVersion} is in the official registry but its signed runtime manifest is not available yet`,
		);
	}
	onProgress?.(`Verified signed runtime manifest for Antigravity ACP ${release.version}.`);
	return installRuntime(release, onProgress);
}

async function ensureOnce(onProgress?: (message: string) => void): Promise<void> {
	configureDefaultAuth();
	let launch: AntigravityLaunch | undefined;
	try {
		launch = resolveAntigravityAcpLaunch();
	} catch {
		// Install the latest signed release below.
	}

	if (launch && launch.source !== "managed") return;
	if (launch) {
		repairRuntimeExecutablePermissions(path.dirname(launch.command));
		if (loadConfig().runtimeUpdates === "automatic") {
			startBackgroundUpdate(launch);
		}
		return;
	}

	const { release } = await resolveLatestRelease(platformKey(), false);
	await installRuntime(release, onProgress);
}

function startBackgroundUpdate(launch: AntigravityLaunch): void {
	backgroundUpdate ??= (async () => {
		// A failed check (offline, registry down) stays silent: it is retried
		// on the next start and must not nag. Only a failed install is reported.
		const { release } = await resolveLatestRelease(platformKey(), false);
		const installedVersion = readInstallRecord(path.dirname(launch.command))?.version;
		if (installedVersion && compareRuntimeVersions(installedVersion, release.version) >= 0) return;
		try {
			const result = await installRuntime(release);
			if (result.changed) {
				recordRuntimeUpdateNotice({
					kind: "updated",
					...(installedVersion ? { from: installedVersion } : {}),
					to: result.version,
					at: Date.now(),
				});
			}
		} catch (cause) {
			recordRuntimeUpdateNotice({
				kind: "failed",
				to: release.version,
				error: cause instanceof Error ? cause.message : String(cause),
				at: Date.now(),
			});
		}
	})()
		.catch(() => {
			// Background update failures must never surface as unhandled rejections
			// or disrupt a working installed runtime.
		})
		.finally(() => {
			backgroundUpdate = undefined;
		});
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(abortError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function resolveLatestRelease(
	key: string,
	force: boolean,
): Promise<{ release: ResolvedRuntimeRelease; officialVersion: string }> {
	const [manifest, official] = await Promise.all([
		loadRuntimeManifest(force),
		fetchOfficialRelease(key, force),
	]);
	const matched = selectApprovedRelease(manifest, official.version);
	if (matched) {
		const asset = matched.platforms[key];
		if (!asset) throw new Error(`No signed Antigravity ACP ${matched.version} build for ${key}`);
		if (asset.archive !== official.entry.archive) {
			throw new Error("Signed runtime manifest differs from the official ACP registry archive");
		}
		if (official.entry.sha256 && asset.archiveSha256 !== official.entry.sha256) {
			throw new Error("Signed runtime manifest differs from the official ACP registry SHA-256");
		}
		return {
			release: { version: matched.version, platform: key, ...asset },
			officialVersion: official.version,
		};
	}

	const approved = latestManifestRelease(manifest);
	const officialRelease = resolveOfficialRelease(key, official);
	if (officialRelease && compareRuntimeVersions(officialRelease.version, approved.version) >= 0) {
		return {
			release: officialRelease,
			officialVersion: official.version,
		};
	}

	const asset = approved.platforms[key];
	if (!asset) throw new Error(`No signed Antigravity ACP ${approved.version} build for ${key}`);
	return {
		release: { version: approved.version, platform: key, ...asset },
		officialVersion: official.version,
	};
}

export function resolveOfficialRelease(
	key: string,
	official: OfficialRegistryRelease,
): ResolvedRuntimeRelease | undefined {
	if (!isRuntimePlatform(key)) return undefined;
	const { version, entry } = official;
	if (!entry || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) return undefined;
	try {
		validateGoogleArchiveUrl(entry.archive, version);
	} catch {
		return undefined;
	}
	const windows = key.startsWith("windows-");
	const binaryName = windows ? "agy_acp_server.exe" : "agy_acp_server.par";
	const harnessName = windows ? "localharness_external.exe" : "localharness_external";
	const commandName = path.posix.basename(String(entry.cmd ?? binaryName).replaceAll("\\", "/"));
	if (commandName !== binaryName) return undefined;
	if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) {
		return undefined;
	}
	return {
		version,
		platform: key,
		archive: entry.archive,
		archiveSha256: entry.sha256,
		binaryName,
		harnessName,
		args: entry.args ?? [],
	};
}

export function selectApprovedRelease(
	manifest: TrustedRuntimeManifest,
	officialVersion: string,
): RuntimeRelease | undefined {
	return manifest.releases.find((release) => release.version === officialVersion);
}

async function loadRuntimeManifest(force: boolean): Promise<TrustedRuntimeManifest> {
	if (!force) {
		const cached = readCachedManifest();
		if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) return cached.manifest;
	}
	try {
		const response = await fetch(RUNTIME_MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Runtime manifest returned HTTP ${response.status}`);
		const manifest = parseTrustedRuntimeManifest(await readBoundedText(response, 256 * 1024));
		writeCachedManifest(manifest);
		return manifest;
	} catch {
		// The package always carries a signed bootstrap catalog. A forced check
		// still refreshes the official registry below, so a newer unapproved
		// release is reported rather than silently installed.
		return readCachedManifest()?.manifest ?? readBundledRuntimeManifest();
	}
}

async function fetchOfficialRelease(key: string, force: boolean): Promise<OfficialRegistryRelease> {
	if (!force) {
		const cached = readCachedOfficialRelease(key);
		if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) return cached.release;
	}
	try {
		const text = await fetchBoundedText(REGISTRY_URL, 256 * 1024, 15_000, "ACP registry");
		const document = JSON.parse(text) as {
			version?: unknown;
			distribution?: { binary?: Record<string, RegistryEntry> };
		};
		if (typeof document.version !== "string") throw new Error("ACP registry version is missing");
		compareRuntimeVersions(document.version, document.version);
		const entry = document.distribution?.binary?.[key];
		if (!entry?.archive) throw new Error(`ACP registry has no ${key} artifact`);
		const release = { version: document.version, entry };
		writeCachedOfficialRelease(key, release);
		return release;
	} catch (error) {
		if (!force) {
			const cached = readCachedOfficialRelease(key);
			if (cached) return cached.release;
		}
		throw error;
	}
}

async function fetchBoundedText(url: string, maxBytes: number, timeoutMs: number, label: string): Promise<string> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
		return await readBoundedText(response, maxBytes);
	} catch (error) {
		if ("mock" in globalThis.fetch) throw error;
		try {
			const { stdout } = await execFileAsync(
				"curl",
				["-fsSL", "--max-time", String(Math.ceil(timeoutMs / 1000)), url],
				{ maxBuffer: maxBytes, timeout: timeoutMs + 2_000 },
			);
			return stdout;
		} catch {
			throw error;
		}
	}
}

async function installRuntime(
	release: ResolvedRuntimeRelease,
	onProgress?: (message: string) => void,
): Promise<{ version: string; changed: boolean; binary: string }> {
	try {
		if (isMuslLinux()) {
			throw new Error(
				"Google publishes a glibc Linux binary; Alpine/musl is not supported. Use a glibc container or AGY_ACP_BIN override.",
			);
		}
		onProgress?.(`Preparing Antigravity ACP ${release.version}…`);
		const root = runtimeRoot();
		return await withInstallLock(root, async () => {
			adoptLegacyCurrentRelease(root, release);
			const current = currentManagedRecord(root);
			if (
				current?.record.archiveSha256 === release.archiveSha256 &&
				isInstalledRelease(path.dirname(current.binary), release)
			) {
				return { version: current.record.version, changed: false, binary: current.binary };
			}
			if (current && compareRuntimeVersions(current.record.version, release.version) > 0) {
				return { version: current.record.version, changed: false, binary: current.binary };
			}

			const destination = path.join(root, "versions", release.archiveSha256);
			const binary = path.join(destination, release.binaryName);
			const destinationValid = isInstalledRelease(destination, release);
			const changed = current?.record.archiveSha256 !== release.archiveSha256 || !destinationValid;
			if (!destinationValid) await installRelease(destination, release, onProgress);
			pointCurrentAt(root, destination);
			onProgress?.(`Antigravity ACP ${release.version} is ready.`);
			return { version: release.version, changed, binary };
		});
	} catch (cause) {
		throw new AntigravityAcpError(
			"spawn",
			`Google Antigravity ACP setup failed: ${cause instanceof Error ? cause.message : String(cause)}. Set AGY_ACP_BIN to a trusted manual installation if needed.`,
			{ cause },
		);
	}
}

async function installRelease(
	destination: string,
	release: ResolvedRuntimeRelease,
	onProgress?: (message: string) => void,
): Promise<void> {
	const versions = path.dirname(destination);
	fs.mkdirSync(versions, { recursive: true, mode: 0o700 });
	cleanStaleStaging(versions);
	const staging = fs.mkdtempSync(path.join(versions, ".install-"));
	const archive = path.join(staging, "download.zip");
	const runtime = path.join(staging, "runtime");
	fs.mkdirSync(runtime, { mode: 0o700 });
	try {
		onProgress?.("Downloading the Antigravity ACP server (this is a large download)…");
		const archiveSha256 = await download(release, archive, onProgress);
		if (archiveSha256 !== release.archiveSha256) throw new Error("Antigravity ACP archive SHA-256 mismatch");
		const archiveBytes = release.archiveBytes ?? fs.statSync(archive).size;
		onProgress?.("Extracting the verified Antigravity ACP runtime…");
		await extractRuntimeArchive(archive, runtime, release);
		fs.rmSync(archive, { force: true });
		const binaryBytes = release.binaryBytes ?? fs.statSync(path.join(runtime, release.binaryName)).size;
		const harnessBytes = release.harnessBytes ?? fs.statSync(path.join(runtime, release.harnessName)).size;
		if (process.platform !== "win32") {
			fs.chmodSync(path.join(runtime, release.binaryName), 0o755);
			fs.chmodSync(path.join(runtime, release.harnessName), 0o755);
		}
		if (process.platform === "darwin") {
			await Promise.all(
				[release.binaryName, release.harnessName].map((name) =>
					execFileAsync("xattr", ["-d", "com.apple.quarantine", path.join(runtime, name)]).catch(() => undefined),
				),
			);
		}
		onProgress?.("Starting the downloaded runtime for ACP validation…");
		await validateRuntime(runtime, release);
		const record: RuntimeInstallRecord = {
			version: release.version,
			platform: release.platform,
			archive: release.archive,
			archiveSha256: release.archiveSha256,
			archiveBytes,
			binaryName: release.binaryName,
			binaryBytes,
			harnessName: release.harnessName,
			harnessBytes,
			installedAt: new Date().toISOString(),
		};
		fs.writeFileSync(path.join(runtime, "install-integrity.json"), `${JSON.stringify(record, null, 2)}\n`, {
			mode: 0o600,
		});
		try {
			fs.renameSync(runtime, destination);
		} catch (error) {
			if (!isInstalledRelease(destination, release)) throw error;
		}
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

function cleanStaleStaging(versions: string): void {
	try {
		for (const entry of fs.readdirSync(versions)) {
			if (entry.startsWith(".install-")) {
				fs.rmSync(path.join(versions, entry), { recursive: true, force: true });
			}
		}
	} catch {
		// Best-effort cleanup while holding the exclusive install lock.
	}
}

async function extractRuntimeArchive(
	archivePath: string,
	destination: string,
	release: ResolvedRuntimeRelease,
): Promise<void> {
	const archive = await Open.file(archivePath);
	validateRuntimeArchiveEntries(archive.files, release);
	const expected = new Map<string, number | undefined>([
		[release.binaryName, release.binaryBytes],
		[release.harnessName, release.harnessBytes],
	]);
	for (const entry of archive.files) {
		const size = expected.get(entry.path) ?? entry.uncompressedSize;
		await pipeline(entry.stream(), fs.createWriteStream(path.join(destination, entry.path), { flags: "wx", mode: 0o600 }));
		if (fs.statSync(path.join(destination, entry.path)).size !== size) {
			throw new Error(`ACP archive file was truncated: ${entry.path}`);
		}
	}
}

export function validateRuntimeArchiveEntries(
	entries: Array<Pick<ZipFile, "type" | "path" | "compressionMethod" | "uncompressedSize">>,
	release: Pick<RuntimeReleaseAsset, "binaryName" | "harnessName"> &
		Partial<Pick<RuntimeReleaseAsset, "binaryBytes" | "harnessBytes">>,
): void {
	const expected = new Map<string, number | undefined>([
		[release.binaryName, release.binaryBytes],
		[release.harnessName, release.harnessBytes],
	]);
	if (entries.length !== expected.size) throw new Error("ACP archive contains an unexpected number of files");
	for (const entry of entries) {
		if (
			!expected.has(entry.path) ||
			entry.type !== "File" ||
			entry.path.includes("/") ||
			entry.path.includes("\\") ||
			(entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
			!Number.isSafeInteger(entry.uncompressedSize) ||
			entry.uncompressedSize <= 0
		) {
			throw new Error("ACP archive contains an unexpected, unsafe, or incorrectly sized file");
		}
		const size = expected.get(entry.path);
		if (size !== undefined && entry.uncompressedSize !== size) {
			throw new Error("ACP archive contains an unexpected, unsafe, or incorrectly sized file");
		}
		expected.delete(entry.path);
	}
	if (expected.size !== 0) throw new Error("ACP archive is missing a required runtime file");
}

export function isExpectedRuntimeIdentity(
	initialized: {
		protocolVersion: number;
		agentInfo?: { name: string; version: string } | null;
	},
	releaseVersion: string,
): boolean {
	// Google reports the release as "agy_acp_server_<semver>" even though the
	// registry and signed manifest use bare semver. Accept both representations,
	// but keep the agent name and complete version match strict.
	const reportedVersion = initialized.agentInfo?.version;
	return (
		initialized.protocolVersion === 1 &&
		initialized.agentInfo?.name === "antigravity-acp" &&
		(reportedVersion === releaseVersion || reportedVersion === `agy_acp_server_${releaseVersion}`)
	);
}

async function validateRuntime(directory: string, release: ResolvedRuntimeRelease): Promise<void> {
	const connection = new AntigravityAcpConnection({
		cwd: directory,
		command: path.join(directory, release.binaryName),
		args: release.args,
		initializeTimeoutMs: VALIDATION_TIMEOUT_MS,
		operationTimeoutMs: VALIDATION_TIMEOUT_MS,
	});
	try {
		const initialized = await connection.initialize();
		if (!isExpectedRuntimeIdentity(initialized, release.version)) {
			throw new Error("Downloaded runtime did not identify as the expected Antigravity ACP release");
		}
	} finally {
		await connection.close();
	}
}

async function download(
	release: ResolvedRuntimeRelease,
	destination: string,
	onProgress?: (message: string) => void,
): Promise<string> {
	if (canUseDirectRangeDownload(release)) {
		try {
			return await downloadDirectParallel(release, destination, onProgress);
		} catch {
			fs.rmSync(destination, { force: true });
		}
	}
	return downloadViaFetch(release, destination, onProgress);
}

function canUseDirectRangeDownload(release: ResolvedRuntimeRelease): boolean {
	return (
		release.archive.startsWith("https://dl.google.com/") &&
		(release.archiveBytes === undefined || release.archiveBytes > PARALLEL_RANGE_BYTES) &&
		!("mock" in globalThis.fetch)
	);
}

async function downloadDirectParallel(
	release: ResolvedRuntimeRelease,
	destination: string,
	onProgress?: (message: string) => void,
): Promise<string> {
	const totalBytes = release.archiveBytes ?? (await fetchArchiveSizeDirect(release.archive));
	if (totalBytes <= PARALLEL_RANGE_BYTES) {
		return downloadViaFetch({ ...release, archiveBytes: totalBytes }, destination, onProgress);
	}
	const ranges: Array<{ start: number; end: number }> = [];
	for (let start = 0; start < totalBytes; start += PARALLEL_RANGE_BYTES) {
		ranges.push({ start, end: Math.min(start + PARALLEL_RANGE_BYTES, totalBytes) - 1 });
	}
	const fd = fs.openSync(destination, "w", 0o600);
	const agent = new https.Agent({ keepAlive: true, maxSockets: PARALLEL_RANGE_CONCURRENCY });
	let received = 0;
	let lastReported = 0;
	try {
		fs.ftruncateSync(fd, totalBytes);
		let nextIndex = 0;
		const workerCount = Math.min(PARALLEL_RANGE_CONCURRENCY, ranges.length);
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (nextIndex < ranges.length) {
					const range = ranges[nextIndex++]!;
					const buffer = await fetchRangeDirect(release.archive, range.start, range.end, agent, (delta) => {
						received += delta;
						const percent = Math.floor((received / totalBytes) * 100);
						if (percent >= lastReported + 10) {
							lastReported = percent;
							onProgress?.(`Downloading Antigravity ACP: ${percent}%`);
						}
					});
					fs.writeSync(fd, buffer, 0, buffer.length, range.start);
				}
			}),
		);
	} finally {
		agent.destroy();
		fs.closeSync(fd);
	}
	if (received !== totalBytes) throw new Error("ACP server download size did not match its signed manifest");
	const hash = createHash("sha256");
	await pipeline(fs.createReadStream(destination), hash);
	return hash.digest("hex");
}

function fetchRangeDirect(
	url: string,
	start: number,
	end: number,
	agent: https.Agent,
	onDelta: (bytes: number) => void,
	attempt = 1,
): Promise<Buffer> {
	const expectedLength = end - start + 1;
	return new Promise<Buffer>((resolve, reject) => {
		let chunkBytes = 0;
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			if (chunkBytes > 0) {
				onDelta(-chunkBytes);
				chunkBytes = 0;
			}
			reject(error);
		};
		const req = https.get(
			url,
			{
				agent: attempt === 1 ? agent : false,
				family: 4,
				headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" },
				timeout: 30_000,
			},
			(res) => {
				if (res.statusCode !== 206) {
					res.resume();
					fail(new Error(`Direct range request returned HTTP ${res.statusCode ?? "unknown"}`));
					return;
				}
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => {
					if (settled) return;
					chunkBytes += chunk.length;
					if (chunkBytes > expectedLength) {
						req.destroy(new Error("Range chunk exceeded requested length"));
						return;
					}
					chunks.push(chunk);
					onDelta(chunk.length);
				});
				res.on("end", () => {
					if (settled) return;
					if (chunkBytes !== expectedLength) {
						fail(new Error("Range chunk was truncated"));
						return;
					}
					settled = true;
					resolve(Buffer.concat(chunks));
				});
				res.on("error", fail);
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("Direct range request timed out"));
		});
		req.on("error", fail);
	}).catch((error) => {
		if (attempt < 5) return fetchRangeDirect(url, start, end, agent, onDelta, attempt + 1);
		throw error;
	});
}

function fetchArchiveSizeDirect(url: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const req = https.request(
			url,
			{
				method: "HEAD",
				agent: false,
				family: 4,
				headers: { "Accept-Encoding": "identity" },
				timeout: 15_000,
			},
			(res) => {
				res.resume();
				if (res.statusCode !== 200) {
					reject(new Error(`Direct HEAD request returned HTTP ${res.statusCode ?? "unknown"}`));
					return;
				}
				const length = Number(res.headers["x-identity-content-length"] ?? res.headers["content-length"]);
				if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ARCHIVE_BYTES) {
					reject(new Error("Invalid or missing Content-Length header on archive HEAD request"));
					return;
				}
				resolve(length);
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("Direct HEAD request timed out"));
		});
		req.on("error", reject);
		req.end();
	});
}

async function downloadViaFetch(
	release: ResolvedRuntimeRelease,
	destination: string,
	onProgress?: (message: string) => void,
): Promise<string> {
	const response = await fetch(release.archive, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
	if (!response.ok || !response.body) throw new Error(`ACP server download returned HTTP ${response.status}`);
	const identityHeader = Number(response.headers.get("x-identity-content-length"));
	const contentLengthHeader = response.headers.get("content-encoding")
		? Number.NaN
		: Number(response.headers.get("content-length"));
	const headerLength = Number.isSafeInteger(identityHeader) && identityHeader > 0 ? identityHeader : contentLengthHeader;
	const expectedBytes =
		release.archiveBytes ?? (Number.isSafeInteger(headerLength) && headerLength > 0 ? headerLength : undefined);
	if (expectedBytes !== undefined && expectedBytes > MAX_ARCHIVE_BYTES) {
		throw new Error("ACP server download exceeded its signed size");
	}
	const hash = createHash("sha256");
	let received = 0;
	let lastReported = 0;
	const progress = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			received += chunk.byteLength;
			if (received > (expectedBytes ?? MAX_ARCHIVE_BYTES)) {
				throw new Error("ACP server download exceeded its signed size");
			}
			hash.update(chunk);
			if (expectedBytes !== undefined) {
				const percent = Math.floor((received / expectedBytes) * 100);
				if (percent >= lastReported + 10) {
					lastReported = percent;
					onProgress?.(`Downloading Antigravity ACP: ${percent}%`);
				}
			}
			controller.enqueue(chunk);
		},
	});
	await pipeline(response.body.pipeThrough(progress), fs.createWriteStream(destination, { mode: 0o600 }));
	if (expectedBytes !== undefined && received !== expectedBytes) {
		throw new Error("ACP server download size did not match its signed manifest");
	}
	return hash.digest("hex");
}

function isInstalledRelease(directory: string, release: ResolvedRuntimeRelease): boolean {
	const record = readInstallRecord(directory);
	if (!record) return false;
	const archiveBytes = release.archiveBytes ?? record.archiveBytes;
	const binaryBytes = release.binaryBytes ?? record.binaryBytes;
	const harnessBytes = release.harnessBytes ?? record.harnessBytes;
	return (
		record.version === release.version &&
		record.platform === release.platform &&
		record.archive === release.archive &&
		record.archiveSha256 === release.archiveSha256 &&
		record.archiveBytes === archiveBytes &&
		record.binaryName === release.binaryName &&
		record.binaryBytes === binaryBytes &&
		record.harnessName === release.harnessName &&
		record.harnessBytes === harnessBytes &&
		validRuntimeFile(path.join(directory, release.binaryName), binaryBytes) &&
		validRuntimeFile(path.join(directory, release.harnessName), harnessBytes)
	);
}

function readInstallRecord(directory: string): RuntimeInstallRecord | undefined {
	try {
		const file = path.join(directory, "install-integrity.json");
		if (fs.statSync(file).size > 8 * 1024) return undefined;
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeInstallRecord;
		if (
			typeof value.version !== "string" ||
			typeof value.platform !== "string" ||
			typeof value.archiveSha256 !== "string" ||
			typeof value.binaryName !== "string" ||
			typeof value.harnessName !== "string"
		) {
			return undefined;
		}
		compareRuntimeVersions(value.version, value.version);
		return value;
	} catch {
		return undefined;
	}
}

export function adoptLegacyCurrentRelease(root: string, release: ResolvedRuntimeRelease): void {
	const directory = path.join(root, "current");
	const file = path.join(directory, "install-integrity.json");
	try {
		const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as {
			version?: unknown;
			platform?: unknown;
			archiveSha256?: unknown;
			installedAt?: unknown;
		};
		if (
			legacy.version !== release.version ||
			legacy.platform !== release.platform ||
			legacy.archiveSha256 !== release.archiveSha256 ||
			release.archiveBytes === undefined ||
			release.binaryBytes === undefined ||
			release.harnessBytes === undefined ||
			!validRuntimeFile(path.join(directory, release.binaryName), release.binaryBytes) ||
			!validRuntimeFile(path.join(directory, release.harnessName), release.harnessBytes)
		) {
			return;
		}
		const record: RuntimeInstallRecord = {
			version: release.version,
			platform: release.platform,
			archive: release.archive,
			archiveSha256: release.archiveSha256,
			archiveBytes: release.archiveBytes,
			binaryName: release.binaryName,
			binaryBytes: release.binaryBytes,
			harnessName: release.harnessName,
			harnessBytes: release.harnessBytes,
			installedAt: typeof legacy.installedAt === "string" ? legacy.installedAt : new Date().toISOString(),
		};
		const temporary = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch {
		// A legacy install is adopted only when every signed field can be proven.
	}
}

function currentManagedRecord(root: string): { record: RuntimeInstallRecord; binary: string } | undefined {
	const current = path.join(root, "current");
	const record = readInstallRecord(current);
	if (!record) return undefined;
	const binary = path.join(current, record.binaryName);
	return validRuntimeFile(binary, record.binaryBytes) ? { record, binary } : undefined;
}

function readCachedManifest(): CachedManifest | undefined {
	try {
		const file = manifestCachePath();
		if (fs.statSync(file).size > 512 * 1024) return undefined;
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
			checkedAt?: unknown;
			manifest?: unknown;
		};
		if (typeof value.checkedAt !== "number" || typeof value.manifest !== "string") return undefined;
		return { checkedAt: value.checkedAt, manifest: parseTrustedRuntimeManifest(value.manifest) };
	} catch {
		return undefined;
	}
}

function writeCachedManifest(manifest: TrustedRuntimeManifest): void {
	const file = manifestCachePath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(
		temporary,
		`${JSON.stringify({ checkedAt: Date.now(), manifest: JSON.stringify(manifest) }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	fs.renameSync(temporary, file);
}

function manifestCachePath(): string {
	return path.join(runtimeRoot(), "runtime-manifest-cache.json");
}

function readCachedOfficialRelease(key: string): CachedOfficialRelease | undefined {
	try {
		const file = officialCachePath(key);
		if (fs.statSync(file).size > 256 * 1024) return undefined;
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CachedOfficialRelease>;
		if (
			typeof value.checkedAt !== "number" ||
			typeof value.release?.version !== "string" ||
			typeof value.release.entry?.archive !== "string"
		) {
			return undefined;
		}
		compareRuntimeVersions(value.release.version, value.release.version);
		return value as CachedOfficialRelease;
	} catch {
		return undefined;
	}
}

function writeCachedOfficialRelease(key: string, release: OfficialRegistryRelease): void {
	const file = officialCachePath(key);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify({ checkedAt: Date.now(), release }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

function officialCachePath(key: string): string {
	return path.join(runtimeRoot(), `official-registry-${key}.json`);
}

function runtimeRoot(): string {
	return path.join(os.homedir(), ".local", "opt", "agy-acp");
}

async function withInstallLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const lock = path.join(root, ".update-lock");
	const deadline = Date.now() + INSTALL_TIMEOUT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
				mode: 0o600,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (isStaleLock(lock)) {
				fs.rmSync(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline) throw new Error("Timed out waiting for another ACP runtime update");
			await delay(LOCK_POLL_MS);
		}
	}
	try {
		return await operation();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

function isStaleLock(lock: string): boolean {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as {
			pid?: unknown;
			createdAt?: unknown;
		};
		if (typeof value.createdAt !== "number" || Date.now() - value.createdAt > LOCK_STALE_MS) return true;
		if (typeof value.pid !== "number") return true;
		try {
			process.kill(value.pid, 0);
			return false;
		} catch {
			return true;
		}
	} catch {
		try {
			return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
		} catch {
			return true;
		}
	}
}

export function repairRuntimeExecutablePermissions(
	directory: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "win32") return [];
	const repaired: string[] = [];
	for (const name of ["agy_acp_server.par", "localharness_external"] as const) {
		const file = path.join(directory, name);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`Managed ACP runtime payload is missing: ${name}`);
			}
			throw error;
		}
		if (!stat.isFile()) throw new Error(`Managed ACP runtime payload is not a regular file: ${name}`);
		const permissions = stat.mode & 0o777;
		const executablePermissions = permissions | ((permissions & 0o444) >> 2);
		if (permissions !== executablePermissions) {
			fs.chmodSync(file, executablePermissions);
			repaired.push(name);
		}
	}
	return repaired;
}

function pointCurrentAt(root: string, destination: string): void {
	const current = path.join(root, "current");
	const temporary = path.join(root, `.current-${process.pid}`);
	fs.rmSync(temporary, { recursive: true, force: true });
	fs.symlinkSync(
		process.platform === "win32" ? destination : path.relative(root, destination),
		temporary,
		process.platform === "win32" ? "junction" : "dir",
	);
	fs.rmSync(current, { recursive: true, force: true });
	fs.renameSync(temporary, current);
}

function configureDefaultAuth(): void {
	const directory = resolveAntigravityAcpDirectory();
	const settingsFile = path.join(directory, "settings.json");
	const tokenFile = path.join(directory, "acp_token.json");
	if (fs.existsSync(tokenFile)) return;
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
		if (settings.auth && typeof settings.auth === "object") return;
	} catch {
		// Create or repair settings below.
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const type = process.env.GEMINI_API_KEY ? "gemini-api-key" : "oauth-personal";
	fs.writeFileSync(settingsFile, `${JSON.stringify({ ...settings, auth: { type } }, null, 2)}\n`, { mode: 0o600 });
}

export function platformKey(): string {
	if (!(process.platform === "linux" || process.platform === "darwin" || process.platform === "win32")) {
		throw new Error(`Unsupported Antigravity ACP platform: ${process.platform}`);
	}
	if (process.arch !== "x64" && process.arch !== "arm64") {
		throw new Error(`Unsupported Antigravity ACP architecture: ${process.arch}`);
	}
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
	return `${platform}-${architecture}`;
}

export function isMuslLinux(): boolean {
	if (process.platform !== "linux") return false;
	if (fs.existsSync("/etc/alpine-release")) return true;
	const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return !report?.header?.glibcVersionRuntime;
}

function validRuntimeFile(file: string, bytes: number): boolean {
	try {
		const stat = fs.statSync(file);
		return stat.isFile() && stat.size === bytes && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
	} catch {
		return false;
	}
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) throw new Error("Response body is missing");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "";
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		reader.releaseLock();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
