import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HISTORY_IDLE_MS, pruneAcpHistory, resolveAcpProfileDir } from "../src/acp/history-cleanup.js";
import { AcpSessionStore } from "../src/acp/session-store.js";

const roots: string[] = [];
const NOW = Date.UTC(2026, 9, 11);
const OLD = new Date(NOW - HISTORY_IDLE_MS - 60_000);
const RECENT = new Date(NOW - 60_000);

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function profile(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-history-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "conversations"));
	fs.mkdirSync(path.join(root, "brain"));
	return root;
}

function write(file: string, content: string, mtime: Date): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.utimesSync(file, mtime, mtime);
}

function conversation(root: string, id: string, mtime: Date): void {
	for (const suffix of [".db", ".db-wal", ".db-shm", ".meta"]) {
		write(path.join(root, "conversations", `${id}${suffix}`), "x".repeat(10), mtime);
	}
	write(path.join(root, "brain", id, "mcp", "result.txt"), "y".repeat(5), mtime);
	fs.utimesSync(path.join(root, "brain", id, "mcp"), mtime, mtime);
	fs.utimesSync(path.join(root, "brain", id), mtime, mtime);
}

const exists = (root: string, ...parts: string[]): boolean => fs.existsSync(path.join(root, ...parts));

describe("pruneAcpHistory", () => {
	it("removes only idle conversations no Pi session can resume", () => {
		const root = profile();
		const orphan = "11111111-1111-4111-8111-111111111111";
		const saved = "22222222-2222-4222-8222-222222222222";
		const active = "33333333-3333-4333-8333-333333333333";
		const brainOnly = "44444444-4444-4444-8444-444444444444";
		conversation(root, orphan, OLD);
		conversation(root, saved, OLD);
		conversation(root, active, OLD);
		write(path.join(root, "conversations", `${active}.db-wal`), "z", RECENT);
		write(path.join(root, "brain", brainOnly, "note.md"), "n", OLD);
		fs.utimesSync(path.join(root, "brain", brainOnly), OLD, OLD);
		write(path.join(root, "brain", "0b4ed0525b8ebee3d0c4d3a88467a65e", "keep"), "k", OLD);
		write(path.join(root, "conversations", "notes.db"), "k", OLD);
		write(path.join(root, "settings.json"), "{}", OLD);

		expect(pruneAcpHistory(new Set([saved]), root, NOW)).toEqual({ removed: 2, bytes: 4 * 10 + 5 + 1 });

		expect(exists(root, "conversations", `${orphan}.db`)).toBe(false);
		expect(exists(root, "conversations", `${orphan}.meta`)).toBe(false);
		expect(exists(root, "brain", orphan)).toBe(false);
		expect(exists(root, "brain", brainOnly)).toBe(false);
		expect(exists(root, "conversations", `${saved}.db`)).toBe(true);
		expect(exists(root, "brain", saved)).toBe(true);
		expect(exists(root, "conversations", `${active}.db`)).toBe(true);
		expect(exists(root, "brain", "0b4ed0525b8ebee3d0c4d3a88467a65e", "keep")).toBe(true);
		expect(exists(root, "conversations", "notes.db")).toBe(true);
		expect(exists(root, "settings.json")).toBe(true);
	});

	it("keeps a conversation whose brain was written below its top directory", () => {
		const root = profile();
		const id = "55555555-5555-4555-8555-555555555555";
		conversation(root, id, OLD);
		write(path.join(root, "brain", id, "mcp", "result.txt"), "fresh", RECENT);
		fs.utimesSync(path.join(root, "brain", id), OLD, OLD);

		expect(pruneAcpHistory(new Set(), root, NOW).removed).toBe(0);
		expect(exists(root, "conversations", `${id}.db`)).toBe(true);
	});

	it("tolerates a profile without history", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-history-"));
		roots.push(root);
		expect(pruneAcpHistory(new Set(), root, NOW)).toEqual({ removed: 0, bytes: 0 });
	});

	it("resolves the profile from GEMINI_HOME", () => {
		vi.stubEnv("GEMINI_HOME", "/tmp/gemini-home");
		expect(resolveAcpProfileDir()).toBe(path.join("/tmp/gemini-home", "antigravity-acp"));
		vi.stubEnv("GEMINI_HOME", "~/custom");
		expect(resolveAcpProfileDir()).toBe(path.join(os.homedir(), "custom", "antigravity-acp"));
	});
});

describe("AcpSessionStore.acpSessionIds", () => {
	it("lists only records that can still be resumed", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-sessions-"));
		roots.push(root);
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const record = {
			acpModelId: "",
			cwd: "/tmp/project",
			messageCount: 0,
			historyFingerprint: "abc",
		};
		store.save({ ...record, piSessionId: "pi-1", acpSessionId: "acp-live", lastActive: Date.now() });
		store.save({ ...record, piSessionId: "pi-2", acpSessionId: "acp-expired", lastActive: Date.now() - 31 * 24 * 60 * 60_000 });
		expect(store.acpSessionIds()).toEqual(new Set(["acp-live"]));
	});
});
