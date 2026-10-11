import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const CONVERSATION_FILE = /^([0-9a-f-]{36})\.(?:db|db-wal|db-shm|meta)$/iu;
const CONVERSATION_SUFFIXES = [".db", ".db-wal", ".db-shm", ".meta"];
/** Long enough that a session another Pi process is still using, or a recent
 * one `/antigravity-acp sessions` can attach, is never removed. */
export const HISTORY_IDLE_MS = 7 * 24 * 60 * 60_000;

/** The server's per-profile store; it honours GEMINI_HOME like the CLI. */
export function resolveAcpProfileDir(): string {
	const home = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
	const directory = home === "~" || home.startsWith("~/") ? path.join(os.homedir(), home.slice(1)) : home;
	return path.join(directory, "antigravity-acp");
}

/** Antigravity keeps every ACP conversation (`conversations/<id>.*` and
 * `brain/<id>/`) forever. Removes those Pi can no longer resume: not in `keep`
 * and untouched for `idleMs`. Credentials, settings and non-UUID entries stay. */
export function pruneAcpHistory(
	keep: ReadonlySet<string>,
	profile = resolveAcpProfileDir(),
	now = Date.now(),
	idleMs = HISTORY_IDLE_MS,
): { removed: number; bytes: number } {
	const conversations = path.join(profile, "conversations");
	const brain = path.join(profile, "brain");
	const ids = new Set<string>();
	for (const name of list(conversations)) {
		const id = CONVERSATION_FILE.exec(name)?.[1];
		if (id && UUID.test(id)) ids.add(id);
	}
	for (const name of list(brain)) if (UUID.test(name)) ids.add(name);

	let removed = 0;
	let bytes = 0;
	for (const id of ids) {
		if (keep.has(id)) continue;
		const files = CONVERSATION_SUFFIXES.map((suffix) => path.join(conversations, `${id}${suffix}`));
		try {
			const entries = [...files, path.join(brain, id)]
				.map((entry) => ({ entry, usage: usage(entry) }))
				.filter((item): item is { entry: string; usage: Usage } => item.usage !== undefined);
			if (entries.some(({ usage }) => now - usage.mtimeMs < idleMs)) continue;
			for (const { entry, usage } of entries) {
				fs.rmSync(entry, { recursive: true, force: true });
				bytes += usage.bytes;
			}
			removed += 1;
		} catch {
			// Unreadable or busy history is left alone and retried on a later start.
		}
	}
	return { removed, bytes };
}

function list(directory: string): string[] {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
}

interface Usage {
	mtimeMs: number;
	bytes: number;
}

/** Undefined only when the entry is absent. A directory's own mtime misses
 * writes to nested files, so walk it. */
function usage(entry: string): Usage | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(entry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const result = { mtimeMs: stat.mtimeMs, bytes: stat.isFile() ? stat.size : 0 };
	if (!stat.isDirectory()) return result;
	for (const child of fs.readdirSync(entry, { withFileTypes: true, recursive: true })) {
		const nested = fs.lstatSync(path.join(child.parentPath, child.name));
		result.mtimeMs = Math.max(result.mtimeMs, nested.mtimeMs);
		if (nested.isFile()) result.bytes += nested.size;
	}
	return result;
}
