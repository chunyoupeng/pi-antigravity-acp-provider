import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_CONFIG_PATH,
	LEGACY_GEMINI_CONFIG_PATH,
	loadConfig,
	resolveConfigPath,
	resolveConfigRoot,
	resolvePiAgentDir,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolOwner,
} from "../src/config.js";

const directories: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalPiCodingAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	}
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("permission configuration", () => {
	it("defaults to yolo and persists an explicit safer mode", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-config-"));
		directories.push(directory);
		const file = path.join(directory, "nested", "config.json");
		expect(loadConfig(file)).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", tools: "pi" });
		saveRuntimeUpdateMode("notify", file);
		savePermissionMode("auto_edit", file);
		saveToolOwner("native", file);
		expect(loadConfig(file)).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", tools: "native" });
	});

	it("resolves default agent directory and config paths when PI_CODING_AGENT_DIR is unset", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);
		expect(resolveConfigRoot()).toBe(path.join(defaultAgentDir, "antigravity-acp-provider"));
		expect(resolveConfigPath()).toBe(path.join(defaultAgentDir, "antigravity-acp-provider", "config.json"));
		expect(DEFAULT_CONFIG_PATH).toBe(path.join(defaultAgentDir, "antigravity-acp-provider", "config.json"));
		expect(LEGACY_GEMINI_CONFIG_PATH).toBe(path.join(defaultAgentDir, "gemini-acp-provider", "config.json"));
	});

	it("respects PI_CODING_AGENT_DIR environment variable", () => {
		// Never inherit a developer's real permission configuration in this test.
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-"));
		directories.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		expect(resolvePiAgentDir()).toBe(customAgentDir);
		expect(resolveConfigRoot()).toBe(path.join(customAgentDir, "antigravity-acp-provider"));
		expect(resolveConfigPath()).toBe(path.join(customAgentDir, "antigravity-acp-provider", "config.json"));

		expect(loadConfig()).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", tools: "pi" });
		savePermissionMode("default");
		expect(loadConfig()).toEqual({ permissions: "default", runtimeUpdates: "automatic", tools: "pi" });

		const configFile = path.join(customAgentDir, "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(configFile)).toBe(true);
	});

	it("expands tilde in PI_CODING_AGENT_DIR", () => {
		process.env.PI_CODING_AGENT_DIR = "~/test-agent-dir";
		expect(resolvePiAgentDir()).toBe(path.join(os.homedir(), "test-agent-dir"));

		process.env.PI_CODING_AGENT_DIR = "~";
		expect(resolvePiAgentDir()).toBe(os.homedir());
	});

	it("falls back to default when PI_CODING_AGENT_DIR is empty or whitespace", () => {
		const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");

		process.env.PI_CODING_AGENT_DIR = "";
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);

		process.env.PI_CODING_AGENT_DIR = "   ";
		expect(resolvePiAgentDir()).toBe(defaultAgentDir);
	});

	it("migrates legacy gemini-acp-provider configuration from default agent directory", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		delete process.env.PI_CODING_AGENT_DIR;

		const legacyDir = path.join(fakeHome, ".pi", "agent", "gemini-acp-provider");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "config.json"),
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "manual" }),
		);

		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "manual", tools: "pi" });
		const targetFile = path.join(fakeHome, ".pi", "agent", "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(targetFile)).toBe(true);
	});

	it("migrates configuration from default Pi agent directory when PI_CODING_AGENT_DIR is custom", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

		const defaultAntigravityDir = path.join(fakeHome, ".pi", "agent", "antigravity-acp-provider");
		fs.mkdirSync(defaultAntigravityDir, { recursive: true });
		fs.writeFileSync(
			path.join(defaultAntigravityDir, "config.json"),
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "notify" }),
		);

		const customAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-agent-migrate-"));
		directories.push(customAgentDir);
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", tools: "pi" });
		const targetFile = path.join(customAgentDir, "antigravity-acp-provider", "config.json");
		expect(fs.existsSync(targetFile)).toBe(true);
		expect(fs.readFileSync(path.join(defaultAntigravityDir, "config.json"), "utf8")).toBe(
			JSON.stringify({ permissions: "auto_edit", runtimeUpdates: "notify" }),
		);
		if (process.platform !== "win32") expect(fs.statSync(targetFile).mode & 0o777).toBe(0o600);
	});

	it("does not overwrite an existing custom profile or copy saved sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-migration-"));
		directories.push(root);
		vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
		const source = path.join(root, "home", ".pi", "agent", "antigravity-acp-provider");
		fs.mkdirSync(source, { recursive: true });
		fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({ permissions: "yolo", runtimeUpdates: "automatic" }));
		fs.writeFileSync(path.join(source, "sessions.json"), "[]");
		process.env.PI_CODING_AGENT_DIR = path.join(root, "custom");
		const target = resolveConfigPath();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const existing = JSON.stringify({ permissions: "default", runtimeUpdates: "manual" });
		fs.writeFileSync(target, existing);
		expect(loadConfig()).toEqual({ permissions: "default", runtimeUpdates: "manual", tools: "pi" });
		expect(fs.readFileSync(target, "utf8")).toBe(existing);
		fs.unlinkSync(target);
		expect(loadConfig()).toEqual({ permissions: "yolo", runtimeUpdates: "automatic", tools: "pi" });
		expect(fs.existsSync(path.join(path.dirname(target), "sessions.json"))).toBe(false);
		expect(fs.existsSync(path.join(source, "sessions.json"))).toBe(true);
	});
});
