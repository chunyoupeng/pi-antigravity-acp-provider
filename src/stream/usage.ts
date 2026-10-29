import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function usageFromPrompt(response: PromptResponse): Usage {
	const usage = emptyUsage();
	const standard = asRecord(response.usage);
	const quota = asRecord(asRecord(response._meta)?.quota);
	const tokens = asRecord(quota?.token_count);
	usage.cacheRead = token(standard?.cachedReadTokens) ?? 0;
	usage.cacheWrite = token(standard?.cachedWriteTokens) ?? 0;
	const input = token(tokens?.input_tokens) ?? token(standard?.inputTokens) ?? 0;
	usage.input = Math.max(0, input - usage.cacheRead);
	usage.output = token(tokens?.output_tokens) ?? token(standard?.outputTokens) ?? 0;
	const reasoning = token(standard?.thoughtTokens);
	if (reasoning !== undefined) usage.reasoning = reasoning;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

/** Pi derives context fill and compaction from `totalTokens`, so it must be
 * the tokens now in the context window. Antigravity 1.3 reports that only as
 * `usage_update`. Antigravity 1.4.3 also fills `PromptResponse.usage`, but
 * those counts are summed over every model call in the turn (an 8-call turn
 * with a ~70k context reported ~350k), which made Pi compact after nearly
 * every multi-tool turn. Prefer the context measurement whenever we have it;
 * fall back to the prompt counts only when no `usage_update` arrived. */
export function withContextUsage(usage: Usage, contextTokens: number | undefined): Usage {
	if (contextTokens === undefined) return usage;
	return contextUsage(contextTokens);
}

export function contextUsage(contextTokens: number): Usage {
	return { ...emptyUsage(), input: contextTokens, totalTokens: contextTokens };
}

function token(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
