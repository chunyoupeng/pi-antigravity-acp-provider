import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

export const CCPA_BASE_URL_ENV = "AGY_ACP_CCPA_BASE_URL";
export const CCPA_RELAY_ENABLED_ENV = "PI_ANTIGRAVITY_CCPA_RELAY";
export const CCPA_UPSTREAM_URL_ENV = "PI_ANTIGRAVITY_CCPA_UPSTREAM_URL";
export const CCPA_MAX_RETRIES_ENV = "PI_ANTIGRAVITY_CCPA_MAX_RETRIES";
export const CCPA_RETRY_BASE_MS_ENV = "PI_ANTIGRAVITY_CCPA_RETRY_BASE_MS";
export const CCPA_CACHE_FILE_ENV = "PI_ANTIGRAVITY_CCPA_CACHE_FILE";
export const CCPA_CACHE_TTL_MS_ENV = "PI_ANTIGRAVITY_CCPA_CACHE_TTL_MS";

export const DEFAULT_CCPA_UPSTREAM_URL = "https://daily-cloudcode-pa.googleapis.com";
export const DEFAULT_MAX_RETRIES = 4;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_CCPA_CACHE_TTL_MS = 30 * 60_000;

const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:", "socks:"]);
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const PROXY_CONNECT_TIMEOUT_MS = 15_000;
const MAX_PROXY_HEADER_BYTES = 16 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_CACHEABLE_BODY_BYTES = 512 * 1024;
const SYSTEM_PROXY_CACHE_TTL_MS = 10_000;

let cachedSystemProxy = { timestamp: 0, url: undefined };

export function shouldStartCcpaRelay(env = process.env) {
	if (env[CCPA_BASE_URL_ENV]?.trim()) return false;
	const flag = env[CCPA_RELAY_ENABLED_ENV]?.trim().toLowerCase();
	if (flag === "0" || flag === "false" || flag === "no" || flag === "off") return false;
	return true;
}

export function shouldBypassProxy(hostname, port, env = process.env) {
	const raw = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(",");
	if (!raw) return false;
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const effectivePort = String(port || "");
	for (const token of raw.split(",")) {
		const entry = token.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		let ruleHost = entry;
		let rulePort = "";
		if (entry.startsWith("[")) {
			const close = entry.indexOf("]");
			if (close !== -1) {
				ruleHost = entry.slice(1, close);
				if (entry[close + 1] === ":") rulePort = entry.slice(close + 2);
			}
		} else if (entry.includes(":")) {
			const [h, p] = entry.split(":");
			ruleHost = h ?? "";
			rulePort = p ?? "";
		}
		if (rulePort && effectivePort && rulePort !== effectivePort) continue;
		if (ruleHost.startsWith(".")) {
			const suffix = ruleHost.slice(1);
			if (host === suffix || host.endsWith(ruleHost)) return true;
		} else if (host === ruleHost || host.endsWith(`.${ruleHost}`)) {
			return true;
		}
	}
	return false;
}

export function parseSystemProxySettings(settings) {
	const field = (key) => settings.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, "m"))?.[1];
	for (const [kind, scheme] of [
		["HTTPS", "http"],
		["HTTP", "http"],
		["SOCKS", "socks5"],
	]) {
		if (field(`${kind}Enable`) !== "1") continue;
		const host = field(`${kind}Proxy`);
		const port = Number(field(`${kind}Port`));
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
		const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		try {
			return new URL(`${scheme}://${address}:${port}`);
		} catch {
			// Continue to next proxy candidate.
		}
	}
	return undefined;
}

export function probeMacSystemProxy(
	readSystemProxy = () =>
		execFileSync("/usr/sbin/scutil", ["--proxy"], {
			encoding: "utf8",
			timeout: 1_500,
			stdio: ["ignore", "pipe", "ignore"],
		}),
	forceRefresh = false,
) {
	const now = Date.now();
	if (!forceRefresh && now - cachedSystemProxy.timestamp < SYSTEM_PROXY_CACHE_TTL_MS) {
		return cachedSystemProxy.url;
	}
	try {
		const url = parseSystemProxySettings(readSystemProxy());
		cachedSystemProxy = { timestamp: now, url };
		return url;
	} catch {
		cachedSystemProxy = { timestamp: now, url: undefined };
		return undefined;
	}
}

export function resolveProxyUrl(targetUrl, env = process.env, options = {}) {
	const port = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");
	if (shouldBypassProxy(targetUrl.hostname, port, env)) return undefined;
	const keys =
		targetUrl.protocol === "https:"
			? ["PI_ANTIGRAVITY_ACP_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
			: ["PI_ANTIGRAVITY_ACP_PROXY", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
	for (const key of keys) {
		const candidate = env[key]?.trim();
		if (!candidate) continue;
		try {
			const parsed = new URL(candidate);
			if (SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) return parsed;
		} catch {
			// Ignore malformed proxy env vars.
		}
	}
	const platform = options.platform ?? process.platform;
	if (platform === "darwin" && options.probeSystemProxy !== false && !process.env.VITEST) {
		return probeMacSystemProxy(options.readSystemProxy, options.forceRefreshSystemProxy);
	}
	if (typeof options.readSystemProxy === "function") {
		return probeMacSystemProxy(options.readSystemProxy, options.forceRefreshSystemProxy);
	}
	return undefined;
}

function resolveCustomCa(env = process.env) {
	const certFile = env.SSL_CERT_FILE?.trim();
	if (!certFile) return undefined;
	try {
		const pem = fs.readFileSync(certFile, "utf8");
		if (pem.includes("-----BEGIN CERTIFICATE-----")) {
			return [...tls.rootCertificates, pem];
		}
	} catch {
		// Fall back to Node's built-in root bundle.
	}
	return undefined;
}

function isSocksProtocol(protocol) {
	return protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks:";
}

export class ProxiedHttpsKeepAliveAgent extends https.Agent {
	constructor(proxyUrl, agentOptions = {}) {
		super({
			keepAlive: true,
			keepAliveMsecs: 30_000,
			maxSockets: 16,
			maxFreeSockets: 8,
			timeout: 300_000,
			...agentOptions,
		});
		this.proxyUrl = proxyUrl;
	}

	createConnection(options, oncreate) {
		if (!oncreate) return super.createConnection(options);
		const targetHost = String(options.servername || options.host || options.hostname || "localhost");
		const targetPort = Number(options.port) || 443;
		const proxyHost = this.proxyUrl.hostname.replace(/^\[|\]$/g, "");
		const defaultProxyPort = isSocksProtocol(this.proxyUrl.protocol)
			? 1080
			: this.proxyUrl.protocol === "https:"
				? 443
				: 80;
		const proxyPort = Number(this.proxyUrl.port) || defaultProxyPort;

		const connectOpts = {
			host: proxyHost,
			port: proxyPort,
			keepAlive: true,
			keepAliveInitialDelay: 30_000,
			noDelay: true,
			...(this.options.ca && this.proxyUrl.protocol === "https:" ? { ca: this.options.ca } : {}),
		};

		let settled = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			err.proxyConnectError = true;
			err.proxyUrl = this.proxyUrl.href;
			proxySocket.destroy();
			oncreate(err);
		};

		const proxySocket =
			this.proxyUrl.protocol === "https:"
				? tls.connect({ ...connectOpts, servername: proxyHost })
				: net.connect(connectOpts);

		const timer = setTimeout(() => {
			fail(new Error(`Proxy CONNECT to ${targetHost}:${targetPort} timed out after ${PROXY_CONNECT_TIMEOUT_MS}ms`));
		}, PROXY_CONNECT_TIMEOUT_MS);
		timer.unref?.();

		const upgradeToTls = (extraBytes) => {
			proxySocket.removeListener("error", onError);
			proxySocket.removeListener("end", onEnd);
			proxySocket.removeListener("close", onClose);
			clearTimeout(timer);
			if (extraBytes && extraBytes.length > 0) proxySocket.unshift(extraBytes);
			settled = true;
			const tlsSocket = tls.connect({
				...options,
				socket: proxySocket,
				servername: targetHost,
				...(this.options.ca ? { ca: this.options.ca } : {}),
			});
			oncreate(null, tlsSocket);
		};

		const onError = (err) => fail(err);
		const onEnd = () => fail(new Error(`Proxy closed connection during CONNECT to ${targetHost}:${targetPort}`));
		const onClose = () => fail(new Error(`Proxy socket closed during CONNECT to ${targetHost}:${targetPort}`));

		proxySocket.once("error", onError);
		proxySocket.once("end", onEnd);
		proxySocket.once("close", onClose);

		if (isSocksProtocol(this.proxyUrl.protocol)) {
			this.#establishSocks5Tunnel(proxySocket, targetHost, targetPort, upgradeToTls, fail);
		} else {
			this.#establishHttpTunnel(proxySocket, targetHost, targetPort, upgradeToTls, fail);
		}

		return undefined;
	}

	#establishHttpTunnel(proxySocket, targetHost, targetPort, upgradeToTls, fail) {
		let headerBuf = Buffer.alloc(0);
		const onData = (chunk) => {
			headerBuf = Buffer.concat([headerBuf, chunk]);
			let headerEnd = headerBuf.indexOf("\r\n\r\n");
			let sepLen = 4;
			if (headerEnd === -1) {
				headerEnd = headerBuf.indexOf("\n\n");
				sepLen = 2;
			}
			if (headerEnd === -1) {
				if (headerBuf.length > MAX_PROXY_HEADER_BYTES) {
					proxySocket.removeListener("data", onData);
					fail(new Error("Proxy CONNECT response headers exceeded maximum size"));
				}
				return;
			}

			proxySocket.removeListener("data", onData);
			const headerText = headerBuf.subarray(0, headerEnd).toString("latin1");
			const statusLine = headerText.split(/\r?\n/, 1)[0] ?? "";
			const match = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(statusLine);
			const statusCode = match ? Number(match[1]) : 0;
			if (statusCode !== 200) {
				fail(new Error(`Proxy CONNECT to ${targetHost}:${targetPort} failed with HTTP ${statusCode || "invalid"}`));
				return;
			}

			upgradeToTls(headerBuf.subarray(headerEnd + sepLen));
		};

		proxySocket.on("data", onData);

		const onConnected = () => {
			let connectReq =
				`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
				`Host: ${targetHost}:${targetPort}\r\n` +
				`Proxy-Connection: Keep-Alive\r\n`;
			if (this.proxyUrl.username || this.proxyUrl.password) {
				const credentials = `${decodeURIComponent(this.proxyUrl.username)}:${decodeURIComponent(this.proxyUrl.password)}`;
				connectReq += `Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}\r\n`;
			}
			connectReq += "\r\n";
			proxySocket.write(connectReq);
		};

		if (this.proxyUrl.protocol === "https:") proxySocket.once("secureConnect", onConnected);
		else proxySocket.once("connect", onConnected);
	}

	#establishSocks5Tunnel(proxySocket, targetHost, targetPort, upgradeToTls, fail) {
		const hasAuth = Boolean(this.proxyUrl.username || this.proxyUrl.password);
		let state = "greeting";
		let buf = Buffer.alloc(0);

		const sendConnectRequest = () => {
			const hostBytes = Buffer.from(targetHost, "utf8");
			if (hostBytes.length > 255) {
				fail(new Error(`SOCKS5 target hostname too long: ${targetHost}`));
				return;
			}
			const req = Buffer.alloc(7 + hostBytes.length);
			req[0] = 0x05; // VER
			req[1] = 0x01; // CMD = CONNECT
			req[2] = 0x00; // RSV
			req[3] = 0x03; // ATYP = DOMAINNAME
			req[4] = hostBytes.length;
			hostBytes.copy(req, 5);
			req.writeUInt16BE(targetPort, 5 + hostBytes.length);
			state = "connect";
			proxySocket.write(req);
		};

		const onData = (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			for (;;) {
				if (state === "greeting") {
					if (buf.length < 2) return;
					const ver = buf[0];
					const method = buf[1];
					buf = buf.subarray(2);
					if (ver !== 0x05) {
						proxySocket.removeListener("data", onData);
						fail(new Error(`Invalid SOCKS5 version from proxy: ${ver}`));
						return;
					}
					if (method === 0x00) {
						sendConnectRequest();
					} else if (method === 0x02 && hasAuth) {
						const user = Buffer.from(decodeURIComponent(this.proxyUrl.username), "utf8");
						const pass = Buffer.from(decodeURIComponent(this.proxyUrl.password), "utf8");
						const authReq = Buffer.concat([
							Buffer.from([0x01, user.length]),
							user,
							Buffer.from([pass.length]),
							pass,
						]);
						state = "auth";
						proxySocket.write(authReq);
					} else {
						proxySocket.removeListener("data", onData);
						fail(new Error(`SOCKS5 proxy rejected authentication methods (0x${(method ?? 0xff).toString(16)})`));
						return;
					}
				} else if (state === "auth") {
					if (buf.length < 2) return;
					const status = buf[1];
					buf = buf.subarray(2);
					if (status !== 0x00) {
						proxySocket.removeListener("data", onData);
						fail(new Error("SOCKS5 username/password authentication failed"));
						return;
					}
					sendConnectRequest();
				} else if (state === "connect") {
					if (buf.length < 4) return;
					const ver = buf[0];
					const rep = buf[1];
					const atyp = buf[3];
					if (ver !== 0x05 || rep !== 0x00) {
						proxySocket.removeListener("data", onData);
						fail(new Error(`SOCKS5 CONNECT to ${targetHost}:${targetPort} failed with code 0x${(rep ?? 0xff).toString(16)}`));
						return;
					}
					let replyLen = 0;
					if (atyp === 0x01) replyLen = 4 + 4 + 2; // IPv4
					else if (atyp === 0x04) replyLen = 4 + 16 + 2; // IPv6
					else if (atyp === 0x03) {
						if (buf.length < 5) return;
						replyLen = 5 + (buf[4] ?? 0) + 2;
					} else {
						proxySocket.removeListener("data", onData);
						fail(new Error(`SOCKS5 unknown address type: ${atyp}`));
						return;
					}
					if (buf.length < replyLen) return;
					const extra = buf.subarray(replyLen);
					proxySocket.removeListener("data", onData);
					upgradeToTls(extra);
					return;
				}
			}
		};

		proxySocket.on("data", onData);
		proxySocket.once("connect", () => {
			const greeting = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
			proxySocket.write(greeting);
		});
	}
}

export function createUpstreamAgent(upstreamUrl, env = process.env, agentOptions = {}) {
	if (upstreamUrl.protocol === "http:") {
		return new http.Agent({
			keepAlive: true,
			keepAliveMsecs: 30_000,
			maxSockets: 16,
			maxFreeSockets: 8,
			timeout: 300_000,
			...agentOptions,
		});
	}
	const ca = agentOptions.ca ?? resolveCustomCa(env);
	const mergedOptions = {
		keepAlive: true,
		keepAliveMsecs: 30_000,
		maxSockets: 16,
		maxFreeSockets: 8,
		timeout: 300_000,
		...(ca ? { ca } : {}),
		...agentOptions,
	};
	const proxyUrl = resolveProxyUrl(upstreamUrl, env);
	if (proxyUrl) {
		return new ProxiedHttpsKeepAliveAgent(proxyUrl, mergedOptions);
	}
	return new https.Agent(mergedOptions);
}

function isRetryableSseErrorChunk(chunk) {
	const text = chunk.toString("utf8").trimStart();
	if (!text.startsWith("data:")) return undefined;
	const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
	const payload = firstLine.slice(5).trim();
	if (!payload.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(payload);
		const code = Number(parsed?.error?.code ?? parsed?.response?.error?.code);
		if (RETRYABLE_STATUS_CODES.has(code)) return code;
	} catch {
		// Not a complete single-line JSON error object.
	}
	return undefined;
}

function sanitizeRequestHeaders(headers, upstreamHost, bodyLength) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "content-length") continue;
		out[key] = value;
	}
	out.host = upstreamHost;
	out["content-length"] = String(bodyLength);
	return out;
}

function sanitizeResponseHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower)) continue;
		out[key] = value;
	}
	return out;
}

function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const onData = (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const onEnd = () => {
			cleanup();
			resolve(Buffer.concat(chunks));
		};
		const onError = (err) => {
			cleanup();
			reject(err);
		};
		const onAborted = () => {
			cleanup();
			reject(new Error("Downstream client aborted request"));
		};
		const cleanup = () => {
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("aborted", onAborted);
		};
		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		req.once("aborted", onAborted);
	});
}

function readErrorBody(res) {
	return new Promise((resolve) => {
		const chunks = [];
		let total = 0;
		res.on("data", (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (total < MAX_ERROR_BODY_BYTES) {
				const slice = buf.subarray(0, MAX_ERROR_BODY_BYTES - total);
				chunks.push(slice);
				total += slice.length;
			}
		});
		res.once("end", () => resolve(Buffer.concat(chunks)));
		res.once("error", () => resolve(Buffer.concat(chunks)));
		res.once("close", () => resolve(Buffer.concat(chunks)));
	});
}

function sleep(ms, onCancel) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		timer.unref?.();
		const cancel = () => {
			clearTimeout(timer);
			cleanup();
			resolve();
		};
		const cleanup = () => onCancel?.(cancel);
		onCancel?.(cancel, true);
	});
}

export async function startCcpaRelay(options = {}) {
	const env = options.env ?? process.env;
	const upstreamUrl = new URL(options.upstreamUrl ?? env[CCPA_UPSTREAM_URL_ENV]?.trim() ?? DEFAULT_CCPA_UPSTREAM_URL);
	const maxRetries =
		options.maxRetries ??
		(env[CCPA_MAX_RETRIES_ENV] !== undefined ? Math.max(0, Number(env[CCPA_MAX_RETRIES_ENV]) || 0) : DEFAULT_MAX_RETRIES);
	const baseDelayMs =
		options.baseDelayMs ??
		(env[CCPA_RETRY_BASE_MS_ENV] !== undefined
			? Math.max(0, Number(env[CCPA_RETRY_BASE_MS_ENV]) || 0)
			: DEFAULT_RETRY_BASE_MS);
	const cacheTtlMs =
		options.cacheTtlMs ??
		(env[CCPA_CACHE_TTL_MS_ENV] !== undefined
			? Math.max(0, Number(env[CCPA_CACHE_TTL_MS_ENV]) || 0)
			: DEFAULT_CCPA_CACHE_TTL_MS);
	const cacheFile =
		options.cacheFile !== undefined
			? options.cacheFile || undefined
			: env[CCPA_CACHE_FILE_ENV]?.trim() ||
				(env.VITEST
					? undefined
					: path.join(
							env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
							"antigravity-acp",
							"ccpa-models-cache.json",
						));
	const log = options.onLog ?? ((message) => process.stderr.write(`${message}\n`));
	const ca = options.tlsOptions?.ca ?? resolveCustomCa(env);
	const baseAgentOptions = {
		keepAlive: true,
		keepAliveMsecs: 30_000,
		maxSockets: 16,
		maxFreeSockets: 8,
		timeout: 300_000,
		...(ca ? { ca } : {}),
		...options.tlsOptions,
	};

	const agentPool = new Map();
	const memoryCache = new Map();
	let preferDirectFallback = false;

	const getCachedResponse = (cacheKey) => {
		if (cacheTtlMs <= 0) return undefined;
		const now = Date.now();
		const memEntry = memoryCache.get(cacheKey);
		if (memEntry && now - memEntry.timestamp < cacheTtlMs) {
			return memEntry;
		}
		if (!cacheFile) return undefined;
		try {
			const diskData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
			const diskEntry = diskData?.entries?.[cacheKey];
			if (
				diskEntry &&
				typeof diskEntry.timestamp === "number" &&
				typeof diskEntry.body === "string" &&
				now - diskEntry.timestamp < cacheTtlMs
			) {
				memoryCache.set(cacheKey, diskEntry);
				return diskEntry;
			}
		} catch {
			// Ignore missing or unreadable cache files.
		}
		return undefined;
	};

	const putCachedResponse = (cacheKey, contentType, bodyBuffer) => {
		if (cacheTtlMs <= 0) return;
		const bodyText = bodyBuffer.toString("utf8");
		try {
			JSON.parse(bodyText);
		} catch {
			return;
		}
		const now = Date.now();
		const entry = {
			timestamp: now,
			contentType: String(contentType || "application/json"),
			body: bodyText,
		};
		memoryCache.set(cacheKey, entry);
		if (!cacheFile) return;
		try {
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
			let existingEntries = {};
			try {
				const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
				if (parsed?.entries && typeof parsed.entries === "object") {
					existingEntries = parsed.entries;
				}
			} catch {
				// Start with a fresh cache object.
			}
			const nextEntries = {};
			for (const [k, v] of Object.entries(existingEntries)) {
				if (v && typeof v.timestamp === "number" && now - v.timestamp < cacheTtlMs) {
					nextEntries[k] = v;
				}
			}
			nextEntries[cacheKey] = entry;
			const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(tmpFile, JSON.stringify({ entries: nextEntries }), "utf8");
			fs.renameSync(tmpFile, cacheFile);
		} catch {
			// Best-effort disk cache write.
		}
	};

	const getAgent = (forceDirect = false, forceRefreshProxy = false) => {
		if (options.agent) return options.agent;
		if (upstreamUrl.protocol === "http:") {
			let httpAgent = agentPool.get("http-direct");
			if (!httpAgent) {
				httpAgent = new http.Agent(baseAgentOptions);
				agentPool.set("http-direct", httpAgent);
			}
			return httpAgent;
		}
		const proxyUrl =
			forceDirect || preferDirectFallback
				? undefined
				: resolveProxyUrl(upstreamUrl, env, {
						readSystemProxy: options.readSystemProxy,
						forceRefreshSystemProxy: forceRefreshProxy,
					});
		const key = proxyUrl ? proxyUrl.href : "https-direct";
		let agent = agentPool.get(key);
		if (!agent) {
			agent = proxyUrl
				? new ProxiedHttpsKeepAliveAgent(proxyUrl, baseAgentOptions)
				: new https.Agent(baseAgentOptions);
			agentPool.set(key, agent);
		}
		return agent;
	};

	const requestFn = upstreamUrl.protocol === "https:" ? https.request : http.request;

	const server = http.createServer(async (clientReq, clientRes) => {
		let clientClosed = false;
		const closeListeners = new Set();
		const markClientClosed = () => {
			if (clientClosed) return;
			clientClosed = true;
			for (const fn of closeListeners) fn();
			closeListeners.clear();
		};
		clientReq.once("aborted", markClientClosed);
		clientRes.once("close", () => {
			if (!clientRes.writableEnded) markClientClosed();
		});

		let body;
		try {
			body = await readRequestBody(clientReq);
		} catch {
			if (!clientRes.headersSent && !clientClosed) {
				clientRes.writeHead(400, { "content-type": "application/json" });
				clientRes.end(JSON.stringify({ error: { code: 400, message: "Failed to read request body" } }));
			}
			return;
		}

		const targetPath = buildUpstreamPath(upstreamUrl.pathname, clientReq.url ?? "/");
		const method = clientReq.method ?? "POST";
		const isCacheableModels =
			cacheTtlMs > 0 &&
			method.toUpperCase() === "POST" &&
			targetPath.endsWith(":fetchAvailableModels") &&
			!String(clientReq.headers[" content-encoding"] ?? clientReq.headers["content-encoding"] ?? "").trim();
		const cacheKey = isCacheableModels ? `${upstreamUrl.origin}${targetPath}:${body.toString("utf8").trim()}` : undefined;
		if (cacheKey) {
			const cached = getCachedResponse(cacheKey);
			if (cached && !clientRes.headersSent && !clientClosed) {
				const payload = Buffer.from(cached.body, "utf8");
				clientRes.writeHead(200, {
					"content-type": cached.contentType || "application/json",
					"content-length": String(payload.length),
					"x-antigravity-ccpa-cache": "HIT",
				});
				clientRes.end(payload);
				return;
			}
		}

		const headers = sanitizeRequestHeaders(clientReq.headers, upstreamUrl.host, body.length);
		if (isCacheableModels) {
			// Request uncompressed JSON when caching so the cross-window cache file stores plain UTF-8 JSON.
			delete headers["accept-encoding"];
		}
		const isStream = targetPath.includes("streamGenerateContent");
		let reusedSocketRetried = false;
		let forceDirectThisRequest = false;
		let forceRefreshProxy = false;

		for (let attempt = 1; attempt <= maxRetries + 1; ) {
			if (clientClosed) return;

			const activeAgent = getAgent(forceDirectThisRequest, forceRefreshProxy);
			forceRefreshProxy = false;

			const outcome = await attemptUpstreamRequest({
				requestFn,
				upstreamUrl,
				targetPath,
				method,
				headers,
				body,
				agent: activeAgent,
				isStream,
				clientRes,
				isClientClosed: () => clientClosed,
				onSuccessBody: cacheKey
					? (statusCode, resHeaders, resBody) => {
							if (statusCode === 200 && !resHeaders["content-encoding"]) {
								putCachedResponse(cacheKey, resHeaders["content-type"], resBody);
							}
						}
					: undefined,
				onCancelRegister: (fn, add) => {
					if (add) closeListeners.add(fn);
					else closeListeners.delete(fn);
				},
			});

			if (outcome.kind === "completed" || clientClosed) {
				return;
			}

			if (outcome.kind === "network_error" && outcome.reusedSocket && !reusedSocketRetried) {
				reusedSocketRetried = true;
				continue;
			}

			// If a local proxy port refused connection (e.g. the user closed Clash/Surge
			// or switched to TUN/direct mode), re-probe system proxy settings and fall
			// back to a direct connection immediately without burning a backoff slot.
			if (
				outcome.kind === "network_error" &&
				outcome.error?.proxyConnectError &&
				!forceDirectThisRequest
			) {
				const refreshedProxy = resolveProxyUrl(upstreamUrl, env, {
					readSystemProxy: options.readSystemProxy,
					forceRefreshSystemProxy: true,
				});
				if (refreshedProxy && refreshedProxy.href !== outcome.error.proxyUrl) {
					log(
						`Antigravity CCPA relay: proxy ${outcome.error.proxyUrl} unreachable (${outcome.error.message}); ` +
							`switching to updated proxy ${refreshedProxy.href}`,
					);
					forceRefreshProxy = true;
					continue;
				}
				log(
					`Antigravity CCPA relay: proxy ${outcome.error.proxyUrl} unreachable (${outcome.error.message}); ` +
						`falling back to direct connection`,
				);
				preferDirectFallback = true;
				forceDirectThisRequest = true;
				continue;
			}

			if (attempt <= maxRetries) {
				const delayMs = baseDelayMs * 2 ** (attempt - 1);
				const reason =
					outcome.kind === "http_error"
						? `HTTP ${outcome.statusCode}`
						: `network error (${outcome.error?.message ?? "unknown"})`;
				log(
					`Antigravity CCPA relay: transient ${reason} on ${clientReq.method ?? "POST"} ${targetPath} ` +
						`(attempt ${attempt}/${maxRetries + 1}); retrying in ${delayMs}ms`,
				);
				await sleep(delayMs, (fn, add) => {
					if (add) closeListeners.add(fn);
					else closeListeners.delete(fn);
				});
				attempt += 1;
				continue;
			}

			if (!clientRes.headersSent && !clientClosed) {
				if (outcome.kind === "http_error") {
					const outHeaders = sanitizeResponseHeaders(outcome.headers ?? {});
					if (outcome.body) outHeaders["content-length"] = String(outcome.body.length);
					clientRes.writeHead(outcome.statusCode, outHeaders);
					clientRes.end(outcome.body ?? Buffer.alloc(0));
				} else {
					const payload = Buffer.from(
						JSON.stringify({
							error: {
								code: 502,
								message: `Network connection failed to CCPA API: ${outcome.error?.message ?? "unknown error"}`,
								status: "UNAVAILABLE",
							},
						}),
						"utf8",
					);
					clientRes.writeHead(502, {
						"content-type": "application/json",
						"content-length": String(payload.length),
					});
					clientRes.end(payload);
				}
			}
			return;
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve(undefined);
		});
	});
	server.unref();

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Antigravity CCPA relay failed to bind a loopback port");
	}

	const baseUrl = `http://127.0.0.1:${address.port}`;
	let closed = false;
	return {
		baseUrl,
		port: address.port,
		upstreamUrl: upstreamUrl.toString(),
		close() {
			if (closed) return Promise.resolve();
			closed = true;
			options.agent?.destroy();
			for (const pooledAgent of agentPool.values()) {
				pooledAgent.destroy();
			}
			agentPool.clear();
			return new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		},
	};
}

function buildUpstreamPath(basePathname, requestUrl) {
	const prefix = basePathname === "/" ? "" : basePathname.replace(/\/+$/, "");
	const suffix = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
	return `${prefix}${suffix}`;
}

function attemptUpstreamRequest({
	requestFn,
	upstreamUrl,
	targetPath,
	method,
	headers,
	body,
	agent,
	isStream,
	clientRes,
	isClientClosed,
	onSuccessBody,
	onCancelRegister,
}) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			onCancelRegister(abortUpstream, false);
			resolve(result);
		};

		const upReq = requestFn(
			{
				protocol: upstreamUrl.protocol,
				hostname: upstreamUrl.hostname,
				port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
				method,
				path: targetPath,
				headers,
				agent,
			},
			async (upRes) => {
				const statusCode = upRes.statusCode ?? 502;
				if (RETRYABLE_STATUS_CODES.has(statusCode)) {
					const errBody = await readErrorBody(upRes);
					finish({
						kind: "http_error",
						statusCode,
						headers: upRes.headers,
						body: errBody,
					});
					return;
				}

				// Wait for the first chunk (or end) before committing response headers
				// so a pre-first-token stream drop or SSE 500 error can still be retried.
				let committed = false;
				const onFirstData = (firstChunk) => {
					cleanupPreCommit();
					const buf = Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk);
					if (isStream && statusCode === 200) {
						const sseErrorCode = isRetryableSseErrorChunk(buf);
						if (sseErrorCode !== undefined) {
							upRes.destroy();
							finish({
								kind: "http_error",
								statusCode: sseErrorCode,
								headers: { "content-type": "application/json" },
								body: buf,
							});
							return;
						}
					}
					committed = true;
					if (isClientClosed()) {
						upRes.destroy();
						finish({ kind: "completed" });
						return;
					}
					clientRes.writeHead(statusCode, sanitizeResponseHeaders(upRes.headers));
					clientRes.write(buf);
					const shouldCapture = typeof onSuccessBody === "function" && statusCode === 200;
					const capturedChunks = shouldCapture ? [buf] : undefined;
					let capturedBytes = shouldCapture ? buf.length : 0;
					let captureOverflow = shouldCapture && capturedBytes > MAX_CACHEABLE_BODY_BYTES;
					if (shouldCapture) {
						upRes.on("data", (chunk) => {
							if (captureOverflow) return;
							const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
							capturedBytes += c.length;
							if (capturedBytes > MAX_CACHEABLE_BODY_BYTES) {
								captureOverflow = true;
								capturedChunks.length = 0;
								return;
							}
							capturedChunks.push(c);
						});
					}
					upRes.pipe(clientRes);
					upRes.once("end", () => {
						if (shouldCapture && !captureOverflow && upRes.complete && capturedChunks) {
							try {
								onSuccessBody(statusCode, upRes.headers, Buffer.concat(capturedChunks));
							} catch {
								// Ignore cache callback errors.
							}
						}
						finish({ kind: "completed" });
					});
					upRes.once("close", () => finish({ kind: "completed" }));
					upRes.once("error", () => {
						clientRes.destroy();
						finish({ kind: "completed" });
					});
				};

				const onEmptyEnd = () => {
					cleanupPreCommit();
					committed = true;
					if (!isClientClosed() && !clientRes.headersSent) {
						clientRes.writeHead(statusCode, sanitizeResponseHeaders(upRes.headers));
						clientRes.end();
					}
					finish({ kind: "completed" });
				};

				const onPreCommitError = (err) => {
					cleanupPreCommit();
					if (!committed) {
						finish({
							kind: "network_error",
							error: err,
							reusedSocket: Boolean(upReq.reusedSocket),
						});
					}
				};

				const onPreCommitClose = () => {
					cleanupPreCommit();
					if (!committed && !upRes.complete) {
						finish({
							kind: "network_error",
							error: new Error("Upstream closed stream before sending any response data"),
							reusedSocket: Boolean(upReq.reusedSocket),
						});
					}
				};

				const cleanupPreCommit = () => {
					upRes.removeListener("data", onFirstData);
					upRes.removeListener("end", onEmptyEnd);
					upRes.removeListener("error", onPreCommitError);
					upRes.removeListener("close", onPreCommitClose);
				};

				upRes.once("data", onFirstData);
				upRes.once("end", onEmptyEnd);
				upRes.once("error", onPreCommitError);
				upRes.once("close", onPreCommitClose);
			},
		);

		const abortUpstream = () => {
			upReq.destroy();
			finish({ kind: "completed" });
		};
		onCancelRegister(abortUpstream, true);

		upReq.once("error", (err) => {
			finish({
				kind: "network_error",
				error: err,
				reusedSocket: Boolean(upReq.reusedSocket),
			});
		});

		upReq.end(body);
	});
}
