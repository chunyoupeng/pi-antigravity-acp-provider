const MAX_LINE_LENGTH = 16 * 1024;

/** Only classify known server/relay error records. Never display raw stderr,
 * response bodies, URLs or credentials in a model-visible warning. */
export class BackendDiagnostics {
	private partial = "";
	private oversized = false;
	private lastError: string | undefined;

	write(chunk: string): void {
		const lines = (this.partial + chunk).split("\n");
		this.partial = lines.pop() ?? "";
		for (const line of lines) {
			if (!this.oversized && line.length <= MAX_LINE_LENGTH) {
				this.lastError = classifyBackendError(line) ?? this.lastError;
			}
			this.oversized = false;
		}
		if (this.partial.length > MAX_LINE_LENGTH) {
			this.partial = "";
			this.oversized = true;
		}
	}

	get error(): string | undefined {
		return (this.oversized ? undefined : classifyBackendError(this.partial)) ?? this.lastError;
	}
}

function classifyBackendError(line: string): string | undefined {
	let message: string;
	if (line.startsWith("Antigravity CCPA relay: ")) {
		// Polling/model-catalog failures are not evidence about inference.
		if (!/ on POST \/[^\s]*:(?:streamGenerateContent|generateContent)\b/u.test(line)) return undefined;
		if (!/^Antigravity CCPA relay: (?:transient|failed) /u.test(line)) return undefined;
		message = line;
	} else {
		// Official server forwards harness errors, but also arbitrary diagnostic
		// text; don't treat quoted user/tool output as an upstream error.
		const record = /(?:^|\] )(?:harness stderr: )?(received model response error: .+|System step error \(HTTP .+|(?:ERROR: logging before google.Init: )?[IWEF]\d{4} .+ (?:planner_generator|stream_handler)\.go:\d+\] (?:Encountered retryable api error\.|error encountered while processing planner output:).+)/u.exec(line);
		if (!record) return undefined;
		message = record[1]!;
	}

	const status = /\b(?:HTTP\s+|Error\s+|code\s+|Status:\s*)([45]\d{2})\b/iu.exec(message)?.[1];
	let detail: string;
	if (status) {
		const reason = status === "503" && /No capacity available/iu.test(message)
			? "model capacity unavailable on the server"
			: status === "503" && /model is currently unreachable/iu.test(message)
				? "model currently unreachable"
				: ({
					"400": "invalid request",
					"401": "authentication required",
					"403": "access denied",
					"404": "requested resource not found",
					"429": "rate limit or quota exceeded",
					"500": "internal server error",
					"502": "bad gateway",
					"503": "service unavailable",
					"504": "gateway timeout",
				} as Record<string, string>)[status] ?? "upstream request failed";
		detail = `HTTP ${status}: ${reason}`;
	} else if (/\bEOF\b|socket hang up|ECONNRESET|closed stream before sending any response data/iu.test(message)) {
		detail = "connection closed/reset before a complete response (EOF)";
	} else if (/ECONNREFUSED/iu.test(message)) {
		detail = "connection refused (ECONNREFUSED)";
	} else if (/ENOTFOUND|EAI_AGAIN/iu.test(message)) {
		detail = "DNS lookup failed";
	} else if (/ETIMEDOUT|timed out|deadline exceeded/iu.test(message)) {
		detail = "network request timed out";
	} else if (/TLS|SSL|certificate/iu.test(message)) {
		detail = "TLS/certificate error";
	} else if (/network error/iu.test(message)) {
		detail = "network request failed (cause not reported)";
	} else {
		return undefined;
	}
	const attempt = /\(attempt (\d{1,3})\/(\d{1,3})\)/u.exec(message);
	if (attempt) detail += ` (attempt ${attempt[1]}/${attempt[2]})`;
	return detail;
}

export function describeBackendSilence(error?: string): string {
	return error
		? `Last observed upstream error: ${error}.`
		: "No upstream error has been reported; the cause of the delay is unknown.";
}
