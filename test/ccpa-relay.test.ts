import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	CCPA_BASE_URL_ENV,
	CCPA_RELAY_ENABLED_ENV,
	resolveProxyUrl,
	shouldBypassProxy,
	shouldStartCcpaRelay,
	startCcpaRelay,
	type CcpaRelayHandle,
} from "../src/acp/ccpa-relay.mjs";
import { AntigravityProcess } from "../src/acp/process.js";

const relays: CcpaRelayHandle[] = [];
const servers: Array<http.Server | https.Server | net.Server> = [];
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(relays.splice(0).map((relay) => relay.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					(server as http.Server).closeAllConnections?.();
				}),
		),
	);
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function listenServer<T extends http.Server | https.Server | net.Server>(server: T): Promise<{ server: T; port: number }> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to bind server");
	return { server, port: address.port };
}

describe("CCPA Keep-Alive and Retry Relay", () => {
	it("reuses a single Keep-Alive upstream connection across consecutive requests", async () => {
		let connectionCount = 0;
		let requestCount = 0;
		const upstream = http.createServer((req, res) => {
			requestCount += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(`data: {"response":{"step":${requestCount},"url":${JSON.stringify(req.url)}}}\n\n`);
		});
		upstream.on("connection", () => {
			connectionCount += 1;
		});
		const { port } = await listenServer(upstream);

		const relay = await startCcpaRelay({
			upstreamUrl: `http://127.0.0.1:${port}`,
			baseDelayMs: 5,
		});
		relays.push(relay);

		for (let step = 1; step <= 3; step += 1) {
			const response = await fetch(`${relay.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer test-token" },
				body: JSON.stringify({ project: "test-proj", model: "gemini-test", request: { step } }),
			});
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain(`"step":${step}`);
		}

		expect(requestCount).toBe(3);
		expect(connectionCount).toBe(1);
	});

	it("retries transient HTTP 500/502/503/504 responses with exponential backoff before streaming", async () => {
		const logs: string[] = [];
		let attempts = 0;
		const upstream = http.createServer((_req, res) => {
			attempts += 1;
			if (attempts === 1) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } }));
				return;
			}
			if (attempts === 2) {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: 503, message: "The model is currently unreachable.", status: "UNAVAILABLE" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('data: {"response":{"candidates":[{"content":{"parts":[{"text":"Success after retries"}]}}]}}\n\n');
			res.end();
		});
		const { port } = await listenServer(upstream);

		const relay = await startCcpaRelay({
			upstreamUrl: `http://127.0.0.1:${port}`,
			maxRetries: 4,
			baseDelayMs: 5,
			onLog: (msg) => logs.push(msg),
		});
		relays.push(relay);

		const response = await fetch(`${relay.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: "p", model: "m", request: {} }),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Success after retries");
		expect(attempts).toBe(3);
		expect(logs).toHaveLength(2);
		expect(logs[0]).toContain("transient HTTP 500");
		expect(logs[1]).toContain("transient HTTP 503 (The model is currently unreachable)");
	});

	it.each([false, true])("logs a safe capacity reason even when retries are exhausted (SSE=%s)", async (sse) => {
		const logs: string[] = [];
		const upstream = http.createServer((_req, res) => {
			res.writeHead(sse ? 200 : 503, { "content-type": sse ? "text/event-stream" : "application/json" });
			const body = JSON.stringify({ error: { code: 503,
				message: "No capacity available for model gemini-test on the server api_key=SECRET user@example.invalid" } });
			res.end(sse ? `data: ${body}\n\n` : body);
		});
		const { port } = await listenServer(upstream);
		const relay = await startCcpaRelay({ upstreamUrl: `http://127.0.0.1:${port}`,
			maxRetries: 0, onLog: (msg) => logs.push(msg) });
		relays.push(relay);
		const response = await fetch(`${relay.baseUrl}/v1internal:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" });
		expect(response.status).toBe(503);
		await response.text();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("failed HTTP 503 (No capacity available)");
		expect(logs[0]).toContain("attempt 1/1");
		expect(logs[0]).not.toMatch(/SECRET|user@example|gemini-test/u);
	});

	it("returns the upstream 500 response when all retries are exhausted and does not retry 4xx errors", async () => {
		let attempts = 0;
		const upstream = http.createServer((req, res) => {
			attempts += 1;
			if (req.url?.includes("bad-request")) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end('{"error":{"code":400,"message":"Invalid argument"}}');
				return;
			}
			res.writeHead(500, { "content-type": "application/json" });
			res.end('{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}');
		});
		const { port } = await listenServer(upstream);

		const relay = await startCcpaRelay({
			upstreamUrl: `http://127.0.0.1:${port}`,
			maxRetries: 2,
			baseDelayMs: 5,
			onLog: () => undefined,
		});
		relays.push(relay);

		const badReq = await fetch(`${relay.baseUrl}/v1internal:generateContent?bad-request=1`, {
			method: "POST",
			body: "{}",
		});
		expect(badReq.status).toBe(400);
		expect(attempts).toBe(1);

		attempts = 0;
		const exhausted = await fetch(`${relay.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			body: "{}",
		});
		expect(exhausted.status).toBe(500);
		expect(await exhausted.text()).toContain("Internal error encountered.");
		expect(attempts).toBe(3);
	});

	it("retries pre-stream socket EOFs and initial SSE 500 error events", async () => {
		let attempts = 0;
		const upstream = http.createServer((_req, res) => {
			attempts += 1;
			if (attempts === 1) {
				// Simulate sudden socket reset before response headers.
				res.socket?.destroy();
				return;
			}
			if (attempts === 2) {
				// Simulate 200 OK headers followed by immediate EOF before first SSE event.
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.flushHeaders();
				res.socket?.destroy();
				return;
			}
			if (attempts === 3) {
				// Simulate 200 OK with an initial SSE 500 error event.
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end('data: {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}\n\n');
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"response":{"ok":true}}\n\n');
		});
		const { port } = await listenServer(upstream);

		const relay = await startCcpaRelay({
			upstreamUrl: `http://127.0.0.1:${port}`,
			maxRetries: 4,
			baseDelayMs: 5,
			onLog: () => undefined,
		});
		relays.push(relay);

		const response = await fetch(`${relay.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"ok":true');
		expect(attempts).toBe(4);
	});

	it("tunnels Keep-Alive HTTPS through an HTTP CONNECT proxy and retries 500s over the tunnel", async () => {
		const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-relay-tls-"));
		tempDirs.push(certDir);
		const keyPath = path.join(certDir, "key.pem");
		const certPath = path.join(certDir, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1,DNS:localhost",
			],
			{ stdio: "ignore" },
		);

		let upstreamAttempts = 0;
		const httpsUpstream = https.createServer(
			{
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath),
			},
			(_req, res) => {
				upstreamAttempts += 1;
				if (upstreamAttempts === 1) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end('{"error":{"code":500,"message":"Internal error encountered."}}');
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ attempt: upstreamAttempts }));
			},
		);
		const { port: upstreamPort } = await listenServer(httpsUpstream);

		let proxyConnects = 0;
		const seenProxyAuth: string[] = [];
		const proxyServer = http.createServer();
		proxyServer.on("connect", (req, clientSocket, head) => {
			proxyConnects += 1;
			if (req.headers["proxy-authorization"]) {
				seenProxyAuth.push(String(req.headers["proxy-authorization"]));
			}
			const [host, portStr] = (req.url ?? "").split(":");
			const upstreamSocket = net.connect(Number(portStr), host || "127.0.0.1", () => {
				clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length > 0) upstreamSocket.write(head);
				upstreamSocket.pipe(clientSocket);
				clientSocket.pipe(upstreamSocket);
			});
			upstreamSocket.on("error", () => clientSocket.destroy());
			clientSocket.on("error", () => upstreamSocket.destroy());
		});
		const { port: proxyPort } = await listenServer(proxyServer);

		const relay = await startCcpaRelay({
			upstreamUrl: `https://localhost:${upstreamPort}`,
			env: {
				HTTPS_PROXY: `http://proxyuser:proxypass@127.0.0.1:${proxyPort}`,
				NO_PROXY: "",
				SSL_CERT_FILE: certPath,
			},
			maxRetries: 3,
			baseDelayMs: 5,
			onLog: () => undefined,
		});
		relays.push(relay);

		const first = await fetch(`${relay.baseUrl}/v1internal:generateContent`, {
			method: "POST",
			body: '{"hello":1}',
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ attempt: 2 });

		const second = await fetch(`${relay.baseUrl}/v1internal:generateContent`, {
			method: "POST",
			body: '{"hello":2}',
		});
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ attempt: 3 });

		// All 3 upstream requests (1 failed 500 + 2 successes) shared a single proxy CONNECT tunnel!
		expect(upstreamAttempts).toBe(3);
		expect(proxyConnects).toBe(1);
		expect(seenProxyAuth[0]).toBe(`Basic ${Buffer.from("proxyuser:proxypass").toString("base64")}`);
	});

	it("evaluates NO_PROXY and relay enablement flags accurately", () => {
		expect(shouldStartCcpaRelay({})).toBe(true);
		expect(shouldStartCcpaRelay({ [CCPA_BASE_URL_ENV]: "https://custom.googleapis.com" })).toBe(false);
		expect(shouldStartCcpaRelay({ [CCPA_RELAY_ENABLED_ENV]: "0" })).toBe(false);
		expect(shouldStartCcpaRelay({ [CCPA_RELAY_ENABLED_ENV]: "false" })).toBe(false);

		expect(shouldBypassProxy("127.0.0.1", 443, { NO_PROXY: "localhost,127.0.0.1,::1" })).toBe(true);
		expect(shouldBypassProxy("daily-cloudcode-pa.googleapis.com", 443, { NO_PROXY: ".googleapis.com" })).toBe(true);
		expect(shouldBypassProxy("daily-cloudcode-pa.googleapis.com", 443, { NO_PROXY: "localhost,127.0.0.1" })).toBe(false);

		const target = new URL("https://daily-cloudcode-pa.googleapis.com");
		expect(resolveProxyUrl(target, { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "127.0.0.1" })?.href).toBe(
			"http://127.0.0.1:7890/",
		);
		expect(resolveProxyUrl(target, { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "*" })).toBeUndefined();
	});

	it("injects AGY_ACP_CCPA_BASE_URL into the supervised child process by default", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-supervisor-env-"));
		tempDirs.push(dir);
		const probeScript = path.join(dir, "probe.mjs");
		fs.writeFileSync(
			probeScript,
			'process.stderr.write(JSON.stringify({ ccpaBaseUrl: process.env.AGY_ACP_CCPA_BASE_URL ?? null })); process.exit(0);\n',
		);

		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.AGY_ACP_CCPA_BASE_URL;
		delete env.PI_ANTIGRAVITY_CCPA_RELAY;
		const child = new AntigravityProcess({
			cwd: process.cwd(),
			entryPath: probeScript,
			env,
		});
		const exit = await child.exited;
		expect(exit.code).toBe(0);
		const parsed = JSON.parse(exit.stderrTail) as { ccpaBaseUrl: string | null };
		expect(parsed.ccpaBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});

	it("tunnels Keep-Alive HTTPS through a SOCKS5 proxy and falls back to direct connection when a configured proxy is closed", async () => {
		const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-relay-socks-"));
		tempDirs.push(certDir);
		const keyPath = path.join(certDir, "key.pem");
		const certPath = path.join(certDir, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1,DNS:localhost",
			],
			{ stdio: "ignore" },
		);

		let upstreamRequests = 0;
		const httpsUpstream = https.createServer(
			{
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath),
			},
			(_req, res) => {
				upstreamRequests += 1;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ request: upstreamRequests }));
			},
		);
		const { port: upstreamPort } = await listenServer(httpsUpstream);

		// Minimal SOCKS5 server (no-auth 0x00, CMD=CONNECT 0x01, ATYP=DOMAIN 0x03).
		let socksConnects = 0;
		const socksServer = net.createServer((clientSocket) => {
			socksConnects += 1;
			let stage: "greeting" | "connect" | "streaming" = "greeting";
			clientSocket.on("data", (chunk) => {
				if (stage === "greeting") {
					stage = "connect";
					clientSocket.write(Buffer.from([0x05, 0x00]));
					return;
				}
				if (stage === "connect") {
					stage = "streaming";
					const hostLen = chunk[4] ?? 0;
					const host = chunk.subarray(5, 5 + hostLen).toString("utf8");
					const port = chunk.readUInt16BE(5 + hostLen);
					const upstreamSocket = net.connect(port, host === "localhost" ? "127.0.0.1" : host, () => {
						clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x00]));
						upstreamSocket.pipe(clientSocket);
						clientSocket.pipe(upstreamSocket);
					});
					upstreamSocket.on("error", () => clientSocket.destroy());
					clientSocket.on("error", () => upstreamSocket.destroy());
				}
			});
		});
		const { port: socksPort } = await listenServer(socksServer);

		const socksRelay = await startCcpaRelay({
			upstreamUrl: `https://localhost:${upstreamPort}`,
			env: {
				ALL_PROXY: `socks5://127.0.0.1:${socksPort}`,
				NO_PROXY: "",
				SSL_CERT_FILE: certPath,
			},
			baseDelayMs: 5,
			onLog: () => undefined,
		});
		relays.push(socksRelay);

		const r1 = await fetch(`${socksRelay.baseUrl}/v1internal:generateContent`, { method: "POST", body: "{}" });
		expect(r1.status).toBe(200);
		const r2 = await fetch(`${socksRelay.baseUrl}/v1internal:generateContent`, { method: "POST", body: "{}" });
		expect(r2.status).toBe(200);
		expect(socksConnects).toBe(1);
		expect(upstreamRequests).toBe(2);

		// Now test dead-proxy -> direct fallback when the configured proxy port refuses connections.
		const logs: string[] = [];
		const fallbackRelay = await startCcpaRelay({
			upstreamUrl: `https://localhost:${upstreamPort}`,
			env: {
				HTTPS_PROXY: "http://127.0.0.1:1", // Unreachable local port (ECONNREFUSED)
				NO_PROXY: "",
				SSL_CERT_FILE: certPath,
			},
			baseDelayMs: 5,
			onLog: (msg) => logs.push(msg),
		});
		relays.push(fallbackRelay);

		const r3 = await fetch(`${fallbackRelay.baseUrl}/v1internal:generateContent`, { method: "POST", body: "{}" });
		expect(r3.status).toBe(200);
		expect(await r3.json()).toEqual({ request: 3 });
		expect(logs.some((line) => line.includes("falling back to direct connection"))).toBe(true);
	});

	it("shares cached fetchAvailableModels responses across relay instances via disk cache", async () => {
		const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-relay-cache-"));
		tempDirs.push(cacheDir);
		const cacheFile = path.join(cacheDir, "ccpa-models-cache.json");

		let upstreamCalls = 0;
		const upstream = http.createServer((_req, res) => {
			upstreamCalls += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					models: { "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1048576 } },
					call: upstreamCalls,
				}),
			);
		});
		const { port: upstreamPort } = await listenServer(upstream);

		const relayWindow1 = await startCcpaRelay({
			upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
			cacheFile,
			cacheTtlMs: 60_000,
			onLog: () => undefined,
		});
		relays.push(relayWindow1);

		const relayWindow2 = await startCcpaRelay({
			upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
			cacheFile,
			cacheTtlMs: 60_000,
			onLog: () => undefined,
		});
		relays.push(relayWindow2);

		const first = await fetch(`${relayWindow1.baseUrl}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: "proj-1" }),
		});
		expect(first.status).toBe(200);
		expect(first.headers.get("x-antigravity-ccpa-cache")).toBeNull();
		expect(await first.json()).toEqual({
			models: { "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1048576 } },
			call: 1,
		});
		expect(upstreamCalls).toBe(1);

		// Window 2 hits the shared disk cache without calling upstream.
		const second = await fetch(`${relayWindow2.baseUrl}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: "proj-1" }),
		});
		expect(second.status).toBe(200);
		expect(second.headers.get("x-antigravity-ccpa-cache")).toBe("HIT");
		expect(await second.json()).toEqual({
			models: { "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1048576 } },
			call: 1,
		});
		expect(upstreamCalls).toBe(1);
	});
});
