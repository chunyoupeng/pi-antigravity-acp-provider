import type { AcpToolActivity } from "./acp/events.js";

/**
 * What one Pi session's extension instance offers the provider. Hosts such as PI WEB load the extension once to
 * collect providers and again for every session, so the provider that runs a request belongs to a different
 * extension instance than the session it serves. This process-wide registry, keyed by Pi session id, lets that
 * provider find the session's folder and the instance that can write the session's entries.
 */
export interface PiSessionHost {
	cwd: string;
	toolActivity: (activity: AcpToolActivity) => void;
}

const REGISTRY = Symbol.for("pi-antigravity-acp.sessions");

function registry(): Map<string, PiSessionHost> {
	const scope = globalThis as Record<symbol, unknown>;
	let sessions = scope[REGISTRY] as Map<string, PiSessionHost> | undefined;
	if (!sessions) {
		sessions = new Map();
		scope[REGISTRY] = sessions;
	}
	return sessions;
}

/** Register a session's host; the returned function removes it only if it is still the registered one. */
export function registerPiSession(sessionId: string, host: PiSessionHost): () => void {
	registry().set(sessionId, host);
	return () => {
		if (registry().get(sessionId) === host) registry().delete(sessionId);
	};
}

export function lookupPiSession(sessionId: string): PiSessionHost | undefined {
	return registry().get(sessionId);
}
