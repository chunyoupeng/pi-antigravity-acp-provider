import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";

// Rotated once to `.1` when a runtime first writes past this size.
const DECISION_LOG_LIMIT = 5 * 1024 * 1024;

export type DecisionFields = Record<string, string | number | boolean | undefined>;

export function resolveDecisionLogPath(): string {
	return path.join(resolveConfigRoot(), "logs", "bindings.jsonl");
}

/** One JSON line per choice the runtime makes about an Antigravity session:
 * which session a turn bound to, what it sent, how the turn ended and why the
 * binding was dropped. The ACP transcript shows what arrived; this shows why,
 * and `scripts/diagnose-session.mjs` lines both up with Pi's session. */
export class DecisionLog {
	private opened = false;

	constructor(private readonly file = resolveDecisionLogPath()) {}

	write(event: string, fields: DecisionFields): void {
		try {
			if (!this.opened) {
				this.opened = true;
				fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
				try {
					if (fs.statSync(this.file).size > DECISION_LOG_LIMIT) fs.renameSync(this.file, `${this.file}.1`);
				} catch {
					// No log yet.
				}
			}
			fs.appendFileSync(this.file, `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
		} catch {
			// Logging is diagnostic only; a full disk must not break the session.
		}
	}
}
