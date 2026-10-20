import { describe, expect, it } from "vitest";
import { BackendDiagnostics, describeBackendSilence } from "../src/acp/backend-diagnostics.js";

const relay = (reason: string, path = "streamGenerateContent?alt=sse") =>
	`Antigravity CCPA relay: transient ${reason} on POST /v1internal:${path} (attempt 2/5); retrying in 2000ms`;
const server = (message: string) =>
	`I1020 15:07:17.529816 6193999872 local_connection.py:551] harness stderr: received model response error: ${message}`;

describe("backend silence diagnostics", () => {
	it.each([
		["HTTP 503 (No capacity available)", "HTTP 503: model capacity unavailable on the server"],
		["HTTP 503", "HTTP 503: service unavailable"],
		["HTTP 503 (The model is currently unreachable)", "HTTP 503: model currently unreachable"],
		["HTTP 500", "HTTP 500: internal server error"],
		["HTTP 502", "HTTP 502: bad gateway"],
		["HTTP 504", "HTTP 504: gateway timeout"],
		["network error (socket hang up)", "connection closed/reset before a complete response (EOF)"],
		["network error (ECONNREFUSED)", "connection refused (ECONNREFUSED)"],
		["network error (EAI_AGAIN)", "DNS lookup failed"],
		["network error (ETIMEDOUT)", "network request timed out"],
		["network error (certificate has expired)", "TLS/certificate error"],
	])("reports observed relay error %s", (reason, expected) => {
		const diagnostics = new BackendDiagnostics();
		diagnostics.write(relay(reason) + "\n");
		expect(diagnostics.error).toBe(`${expected} (attempt 2/5)`);
	});

	it.each([
		["UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-medium on the server", "HTTP 503: model capacity unavailable on the server"],
		["Error 502, Message: Bad Gateway: Failed to connect to backend API", "HTTP 502: bad gateway"],
		["RESOURCE_EXHAUSTED (code 429): quota exceeded", "HTTP 429: rate limit or quota exceeded"],
		["Post https://example.invalid: EOF", "connection closed/reset before a complete response (EOF)"],
	])("reads official harness error %s", (message, expected) => {
		const diagnostics = new BackendDiagnostics();
		const line = server(message);
		for (let offset = 0; offset < line.length; offset += 7) diagnostics.write(line.slice(offset, offset + 7));
		expect(diagnostics.error).toBe(expected); // No terminating newline is required.
	});

	it("recognizes retry/exhaustion and system error records", () => {
		const diagnostics = new BackendDiagnostics();
		diagnostics.write('W1020 11:13:40.405580 8364965760 local_connection.py:524] System step error (HTTP 503): No capacity available\n');
		expect(diagnostics.error).toContain("HTTP 503: model capacity unavailable");
		diagnostics.write('I1020 11:13:35.141806 6151172096 local_connection.py:551] harness stderr: ERROR: logging before google.Init: I1020 11:13:35.141760 77 planner_generator.go:348] Encountered retryable api error. retrying in 5s. Error 500, Message: Internal error encountered.\n');
		expect(diagnostics.error).toBe("HTTP 500: internal server error");
		diagnostics.write(relay("HTTP 504").replace("transient", "failed") + "\n");
		expect(diagnostics.error).toBe("HTTP 504: gateway timeout (attempt 2/5)");
	});

	it("does not leak raw stderr, URLs, credentials or quoted prompt contents", () => {
		const diagnostics = new BackendDiagnostics();
		diagnostics.write('input_loop.go:106] HandleUserInput called with text: "Error 502 No capacity available"\n');
		diagnostics.write(relay("HTTP 503 (No capacity available)", "fetchAvailableModels") + "\n");
		diagnostics.write('W1020 11:00:00.000 503 example.py:123] random warning about 502\n');
		expect(diagnostics.error).toBeUndefined();
		diagnostics.write(server('Error 503 No capacity available api_key=SECRET https://user:password@example.invalid/private') + "\n");
		expect(describeBackendSilence(diagnostics.error)).toBe("Last observed upstream error: HTTP 503: model capacity unavailable on the server.");
	});

	it("bounds oversized lines and still accepts the next record", () => {
		const diagnostics = new BackendDiagnostics();
		diagnostics.write("x".repeat(20_000));
		diagnostics.write(server("Error 502"));
		expect(diagnostics.error).toBeUndefined();
		diagnostics.write("\n" + relay("HTTP 500") + "\n");
		expect(diagnostics.error).toContain("HTTP 500");
		diagnostics.write(relay("HTTP 503"));
		expect(diagnostics.error).toContain("HTTP 503");
	});

	it("does not invent an outage or 502 when no error was observed", () => {
		expect(describeBackendSilence()).toBe("No upstream error has been reported; the cause of the delay is unknown.");
	});
});
