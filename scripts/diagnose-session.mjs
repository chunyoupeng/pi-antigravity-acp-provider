// Lines up one Pi session with the provider's decision log and the Antigravity
// transcripts it used, in local time, and flags context jumps, history replayed
// into a non-empty session and backend errors.
//
//   node scripts/diagnose-session.mjs [session.jsonl | session id | cwd] [--all]
//
// With no argument it reads the latest Pi session for the current directory.
// --all also prints every model step instead of only notable ones.
import fs from "node:fs";
import path from "node:path";

// Only modules without relative imports load under Node's type stripping, so
// the decision log and session store paths are spelled out here.
import { resolveAcpProfileDir } from "../src/acp/history-cleanup.ts";
import { resolveConfigRoot, resolvePiAgentDir } from "../src/config.ts";

const DECISION_LOG = path.join(resolveConfigRoot(), "logs", "bindings.jsonl");
const SESSION_STORE = path.join(resolveConfigRoot(), "sessions.json");

/** A rise in context this large between two model steps is flagged. */
const JUMP_TOKENS = 30_000;
/** Pi's own steps closer than this to a printed one are folded away. */
const PRINT_STEP_TOKENS = 10_000;
const CONTEXT_RESOURCE = "urn:pi:antigravity-acp:context/";

const args = process.argv.slice(2);
const all = args.includes("--all");
const target = args.find((arg) => !arg.startsWith("--"));
const sessionFile = findSessionFile(target);
const piEntries = readJsonl(sessionFile);
const header = piEntries.find((entry) => entry.type === "session");
if (!header) fail(`${sessionFile} has no session header`);
const piId = header.id;

const events = [];
const findings = [];
const add = (time, source, text, flag) => {
	events.push({ time: Date.parse(time), source, text, flag });
	if (flag) findings.push({ time: Date.parse(time), source, flag });
};

readPiSession();
const decisions = readDecisions();
const acpIds = new Map();
for (const decision of decisions) acpIds.set(decision.acp, "decision log");
const saved = readJson(SESSION_STORE)?.find?.((record) => record.piSessionId === piId);
if (saved && !acpIds.has(saved.acpSessionId)) acpIds.set(saved.acpSessionId, "sessions.json (latest only)");
for (const acp of acpIds.keys()) readTranscript(acp);

events.sort((a, b) => a.time - b.time);
const first = new Date(events[0]?.time ?? Date.now());
console.log(`Pi session ${piId}  ${header.cwd}`);
console.log(`file        ${sessionFile}`);
console.log(`times       local ${first.toDateString()} (UTC${utcOffset(first)})`);
console.log(`ACP         ${[...acpIds].map(([id, source]) => `${short(id)} via ${source}`).join(", ") || "none found"}`);
if (decisions.length === 0) {
	console.log("decisions   none logged for this session (it predates the decision log or ran no prompt);");
	console.log("            ACP sessions other than the latest saved one are not listed.");
}
console.log("");
const width = Math.max(...events.map((event) => event.source.length), 3);
for (const event of events) {
	const line = `${clock(event.time)}  ${event.source.padEnd(width)}  ${event.text}`;
	console.log(event.flag ? `${line}\n${" ".repeat(10 + width)}!! ${event.flag}` : line);
}
console.log("");
if (findings.length === 0) console.log("No anomalies flagged.");
else {
	console.log(`${findings.length} flagged:`);
	for (const finding of findings.sort((a, b) => a.time - b.time)) console.log(`  ${clock(finding.time)}  ${finding.source}  ${finding.flag}`);
}

function readPiSession() {
	let context = 0;
	let printed = 0;
	for (const entry of piEntries) {
		if (entry.type === "compaction") {
			add(entry.timestamp, "pi", `compaction (tokens before ${entry.tokensBefore})`);
			context = 0;
			printed = 0;
		} else if (entry.type === "model_change") {
			add(entry.timestamp, "pi", `model ${entry.provider}/${entry.modelId}`);
		} else if (entry.type === "message" && entry.message.role === "user") {
			add(entry.timestamp, "pi", `user: ${clip(textOf(entry.message.content), 80)}`);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const tokens = message.usage?.totalTokens ?? 0;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				add(entry.timestamp, "pi", `${message.stopReason}: ${clip(message.errorMessage ?? textOf(message.content), 140)}`);
				continue;
			}
			if (tokens === 0) continue;
			const jump = context > 0 && tokens - context >= JUMP_TOKENS
				? `context +${kilo(tokens - context)} in one step (${kilo(context)} -> ${kilo(tokens)})`
				: undefined;
			if (all || jump || message.stopReason === "stop" || Math.abs(tokens - printed) >= PRINT_STEP_TOKENS) {
				add(entry.timestamp, "pi", `context ${kilo(tokens)}${message.stopReason === "stop" ? "  (turn done)" : ""}`, jump);
				printed = tokens;
			}
			context = tokens;
		}
	}
}

function readDecisions() {
	const file = DECISION_LOG;
	const entries = [...readJsonl(`${file}.1`, true), ...readJsonl(file, true)].filter((entry) => entry.pi === piId);
	const restoredBy = new Map();
	for (const entry of entries) {
		const source = `dec:${short(entry.acp)}`;
		if (entry.event === "bind") {
			restoredBy.set(entry.acp, entry.how === "new" ? undefined : entry.how);
			const fallback = entry.savedAcp ? `, saved ${short(entry.savedAcp)} not restorable` : "";
			add(entry.t, source, `bind ${entry.how} messageCount=${entry.messageCount} ${entry.model}${fallback}`);
		} else if (entry.event === "prompt") {
			if (entry.lateResults !== undefined) {
				add(entry.t, source, `prompt ${entry.lateResults} late tool result(s)`);
				continue;
			}
			const replay = entry.fresh && restoredBy.get(entry.acp)
				? `full Pi history sent into a session restored by ${restoredBy.get(entry.acp)}; it already holds that history`
				: undefined;
			add(entry.t, source, `prompt ${entry.fresh ? "fresh" : "delta"} messages ${entry.from}..${entry.to} ${kilo(entry.bytes, "B")}`, replay);
			restoredBy.set(entry.acp, undefined);
		} else if (entry.event === "end") {
			add(entry.t, source, entry.error
				? `end ${entry.aborted ? "aborted" : "error"}: ${clip(entry.error, 140)}`
				: `end ${entry.stop} tokens=${kilo(entry.tokens)}`);
		} else if (entry.event === "drop") {
			add(entry.t, source, `drop: ${entry.reason}${entry.removeSaved ? " (saved record removed)" : ""}`);
		} else if (entry.event === "exit") {
			add(entry.t, source, `process exited code=${entry.code ?? "-"} signal=${entry.signal ?? "-"}`);
		} else if (entry.event === "checkpoint") {
			add(entry.t, source, `Antigravity checkpoint #${entry.checkpoints}`, "the harness replaced history with its own summary");
		}
	}
	return entries;
}

function readTranscript(acp) {
	const file = path.join(resolveAcpProfileDir(), "brain", acp, ".system_generated", "logs", "transcript_full.jsonl");
	const steps = readJsonl(file, true);
	if (steps.length === 0) {
		add(new Date().toISOString(), `acp:${short(acp)}`, `transcript missing: ${file}`);
		return;
	}
	const source = `acp:${short(acp)}`;
	let previous = 0;
	let errors = [];
	const flushErrors = () => {
		if (errors.length === 0) return;
		const kinds = [...new Set(errors.map((step) => `${step.error_code ?? "?"} ${step.error ?? ""}`.trim()))].join("; ");
		const span = errors.length > 1 ? ` x${errors.length} until ${clock(Date.parse(errors.at(-1).created_at))}` : "";
		add(errors[0].created_at, source, `backend error ${kinds}${span}`);
		errors = [];
	};
	steps.forEach((step, index) => {
		if (step.type !== "ERROR_MESSAGE") flushErrors();
		const text = typeof step.content === "string" ? step.content : JSON.stringify(step.content ?? "");
		if (step.type === "USER_INPUT") {
			const history = text.includes(CONTEXT_RESOURCE);
			const replay = history && index > 0
				? `Pi history replayed into a session that already has ${index} steps`
				: undefined;
			const what = history ? "Pi history" : `"${clip(userRequest(text), 60)}"`;
			add(step.created_at, source, `USER_INPUT ${kilo(Buffer.byteLength(text, "utf8"), "B")} ${what}`, replay);
		} else if (step.type === "ERROR_MESSAGE") {
			errors.push(step);
		} else if (step.type === "CHECKPOINT") {
			add(step.created_at, source, "CHECKPOINT", "the harness replaced history with its own summary");
		} else if (step.type === "PLANNER_RESPONSE" && typeof step.input_tokens === "number") {
			const tokens = step.input_tokens + (step.cache_read_tokens ?? 0) + (step.output_tokens ?? 0);
			const jump = previous > 0 && tokens - previous >= JUMP_TOKENS
				? `real prompt +${kilo(tokens - previous)} (${kilo(previous)} -> ${kilo(tokens)})`
				: undefined;
			if (all || jump) {
				add(step.created_at, source, `model step ${kilo(tokens)} (input ${kilo(step.input_tokens)}, cached ${kilo(step.cache_read_tokens ?? 0)})`, jump);
			}
			previous = tokens;
		}
	});
	flushErrors();
}

function findSessionFile(arg) {
	if (arg && fs.existsSync(arg) && fs.statSync(arg).isFile()) return path.resolve(arg);
	const root = path.join(resolvePiAgentDir(), "sessions");
	if (!arg || (fs.existsSync(arg) && fs.statSync(arg).isDirectory())) {
		const cwd = path.resolve(arg ?? process.cwd());
		const directory = path.join(root, `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`);
		const latest = list(directory).filter((name) => name.endsWith(".jsonl"))
			.map((name) => path.join(directory, name))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
		if (!latest) fail(`no Pi sessions under ${directory}`);
		return latest;
	}
	const matches = list(root).flatMap((directory) =>
		list(path.join(root, directory)).filter((name) => name.includes(arg)).map((name) => path.join(root, directory, name)));
	if (matches.length !== 1) fail(matches.length === 0 ? `no Pi session matches ${arg}` : `${arg} matches:\n${matches.join("\n")}`);
	return matches[0];
}

function readJsonl(file, optional = false) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (optional) return [];
		throw error;
	}
	return text.split("\n").filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function list(directory) {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
}

function textOf(content) {
	if (typeof content === "string") return content;
	return (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(" ");
}

function userRequest(text) {
	return /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u.exec(text)?.[1] ?? text;
}

function clip(text, limit) {
	const flat = String(text).replace(/\s+/gu, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function kilo(value, unit = "") {
	if (typeof value !== "number") return "?";
	return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k${unit}` : `${value}${unit}`;
}

function short(id) {
	return String(id).slice(0, 8);
}

function clock(time) {
	return new Date(time).toTimeString().slice(0, 8);
}

function utcOffset(date) {
	const minutes = -date.getTimezoneOffset();
	const sign = minutes >= 0 ? "+" : "-";
	const absolute = Math.abs(minutes);
	return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
