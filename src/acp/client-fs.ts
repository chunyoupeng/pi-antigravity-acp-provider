import {
	RequestError,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type WriteTextFileRequest,
	type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;

/** Roots the Antigravity server itself treats as workspace: the session cwd,
 * the user's home directory, GEMINI_HOME (skills, plans and other artifacts)
 * and the system temp dir. */
export function clientFileRoots(cwd: string): string[] {
	const geminiHome = process.env.GEMINI_HOME?.trim() || path.join(os.homedir(), ".gemini");
	return [cwd, os.homedir(), geminiHome, os.tmpdir()];
}

/** ACP `fs/read_text_file`, served by the provider instead of the agent. */
export async function readClientTextFile(
	request: ReadTextFileRequest,
	roots: readonly string[],
): Promise<ReadTextFileResponse> {
	const file = await confine(request.path, roots);
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch (error) {
		throw fileError(error, request.path);
	}
	if (!stat.isFile()) throw RequestError.invalidParams(undefined, `Not a regular file: ${request.path}`);
	if (stat.size > MAX_READ_BYTES) {
		throw RequestError.invalidParams(undefined, `File exceeds ${MAX_READ_BYTES} bytes: ${request.path}`);
	}
	const content = await fs.promises.readFile(file, "utf8");
	const line = request.line ?? undefined;
	const limit = request.limit ?? undefined;
	if (line === undefined && limit === undefined) return { content };
	const lines = content.split("\n");
	const start = Math.max(0, (line ?? 1) - 1);
	const end = limit === undefined ? lines.length : start + Math.max(0, limit);
	return { content: lines.slice(start, end).join("\n") };
}

/** ACP `fs/write_text_file`: creates parents and replaces the file atomically. */
export async function writeClientTextFile(
	request: WriteTextFileRequest,
	roots: readonly string[],
): Promise<WriteTextFileResponse> {
	if (Buffer.byteLength(request.content, "utf8") > MAX_WRITE_BYTES) {
		throw RequestError.invalidParams(undefined, `Content exceeds ${MAX_WRITE_BYTES} bytes: ${request.path}`);
	}
	const file = await confine(request.path, roots);
	let mode = 0o644;
	try {
		const stat = await fs.promises.stat(file);
		if (!stat.isFile()) throw RequestError.invalidParams(undefined, `Not a regular file: ${request.path}`);
		mode = stat.mode & 0o7777;
	} catch (error) {
		if (error instanceof RequestError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fileError(error, request.path);
	}
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, request.content, { mode });
		await fs.promises.rename(temporary, file);
	} catch (error) {
		await fs.promises.rm(temporary, { force: true });
		throw fileError(error, request.path);
	}
	return {};
}

/** Resolves symlinks (through the nearest existing ancestor for new files) and
 * rejects anything that lands outside every root. */
async function confine(requested: string, roots: readonly string[]): Promise<string> {
	if (!path.isAbsolute(requested)) {
		throw RequestError.invalidParams(undefined, `Path must be absolute: ${requested}`);
	}
	const resolved = await realpathAllowingMissing(path.resolve(requested));
	for (const root of roots) {
		const realRoot = await realpathAllowingMissing(path.resolve(root));
		const relative = path.relative(realRoot, resolved);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
	}
	throw RequestError.invalidParams(undefined, `Path is outside the Pi workspace: ${requested}`);
}

async function realpathAllowingMissing(target: string): Promise<string> {
	const missing: string[] = [];
	let current = target;
	for (;;) {
		try {
			return path.join(await fs.promises.realpath(current), ...missing.reverse());
		} catch (error) {
			const parent = path.dirname(current);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

function fileError(error: unknown, requested: string): RequestError {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return RequestError.resourceNotFound(requested);
	return RequestError.internalError(undefined, `${requested}: ${error instanceof Error ? error.message : String(error)}`);
}
