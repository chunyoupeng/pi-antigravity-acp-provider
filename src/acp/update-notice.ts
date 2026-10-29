import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";

/** Outcome of a silent background runtime update, surfaced to the user once.
 * A new server version can change how Antigravity counts and compacts context
 * without any error, so the user must at least know that the version changed. */
export type RuntimeUpdateNotice =
	| { kind: "updated"; from?: string; to: string; at: number }
	| { kind: "failed"; to: string; error: string; at: number };

type NoticeListener = (notice: RuntimeUpdateNotice) => void;

let listener: NoticeListener | undefined;

export function runtimeUpdateNoticePath(root = resolveConfigRoot()): string {
	return path.join(root, "runtime-update-notice.json");
}

/** Deliver the notice to a live Pi session, or keep it for the next start. */
export function recordRuntimeUpdateNotice(notice: RuntimeUpdateNotice, file = runtimeUpdateNoticePath()): void {
	if (listener) {
		try {
			listener(notice);
			return;
		} catch {
			// Fall through and persist so the notice is not lost.
		}
	}
	try {
		const pending = readNotices(file).filter((existing) => existing.kind !== notice.kind || existing.to !== notice.to);
		pending.push(notice);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, `${JSON.stringify(pending.slice(-5), null, 2)}\n`, { mode: 0o600 });
	} catch {
		// Notices are advisory and must never break the update itself.
	}
}

/** Read and clear notices left by an earlier process. */
export function takeRuntimeUpdateNotices(file = runtimeUpdateNoticePath()): RuntimeUpdateNotice[] {
	const notices = readNotices(file);
	if (notices.length > 0) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Showing a notice twice is better than not showing it.
		}
	}
	return notices;
}

export function setRuntimeUpdateNoticeListener(next: NoticeListener | undefined): void {
	listener = next;
}

export function formatRuntimeUpdateNotice(notice: RuntimeUpdateNotice): string {
	if (notice.kind === "failed") {
		return `Antigravity ACP automatic update to ${notice.to} failed: ${notice.error}. The installed runtime keeps working; run /antigravity-acp update to retry.`;
	}
	const from = notice.from ? `${notice.from} → ` : "";
	return (
		`Antigravity ACP was updated automatically: ${from}${notice.to}. ` +
		"New server versions can change context counting and compaction silently; " +
		"if turns start compacting unexpectedly or tools misbehave, run /antigravity-acp updates manual and report it."
	);
}

function readNotices(file: string): RuntimeUpdateNotice[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return Array.isArray(parsed) ? parsed.filter(isNotice) : [];
	} catch {
		return [];
	}
}

function isNotice(value: unknown): value is RuntimeUpdateNotice {
	if (!value || typeof value !== "object") return false;
	const notice = value as Record<string, unknown>;
	if (typeof notice.to !== "string" || typeof notice.at !== "number") return false;
	if (notice.kind === "updated") return notice.from === undefined || typeof notice.from === "string";
	return notice.kind === "failed" && typeof notice.error === "string";
}
