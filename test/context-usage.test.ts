import { type Context, normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	buildPromptParts,
	PI_READ_EXAMINE_RULE,
} from "../src/stream/context.js";
import { quotaFromPrompt } from "../src/status.js";
import { usageFromPrompt, withContextUsage } from "../src/stream/usage.js";

describe("prompt context", () => {
	it("reconstructs history only for a fresh binding", () => {
		const context: Context = {
			systemPrompt: "Follow project rules",
			messages: [
				{ role: "user", content: "old", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "prior" }],
					api: "antigravity-acp",
					provider: "antigravity-acp",
					model: "auto",
					usage: usageFromPrompt({ stopReason: "end_turn" }),
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "new", timestamp: 3 },
			],
		};
		const fresh = buildPromptParts(context, true);
		const warm = buildPromptParts(context, false);
		expect(fresh.prompt).toHaveLength(2);
		expect(fresh.prompt[0]?.type).toBe("resource");
		expect(warm.prompt).toEqual([{ type: "text", text: "new" }]);
	});

	it("reconstructs instructions from an actual normalized context without undefined tool results", () => {
		const context = normalizeContext({
			systemPrompt: "Follow project rules",
			messages: [
				{ role: "user", content: "old", timestamp: 1 },
				{ role: "user", content: "new", timestamp: 2 },
			],
		});
		const result = buildPromptParts(context, true);
		expect(result.messageCount).toBe(context.messages.length);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: {
				text: expect.stringContaining("# Pi session instructions\n\nFollow project rules\n\n---\n\n# Prior conversation"),
			},
		});
		const serialized = JSON.stringify(result.prompt);
		expect(serialized).toContain("## User");
		expect(serialized).toContain("old");
		expect(serialized).not.toContain("Tool result (undefined)");
		expect(buildPromptParts(context, false).prompt).toEqual([{ type: "text", text: "new" }]);
	});

	it("replays appended system content and section updates and removals", () => {
		const context = normalizeContext({
			systemPrompt: "Base instructions",
			messages: [
				{
					role: "system",
					content: [{ type: "text", text: "Additional instructions" }],
					sections: { project: "Old project rules", temporary: "Obsolete rules" },
					timestamp: 1,
				},
				{ role: "user", content: "old", timestamp: 2 },
				{
					role: "system",
					content: "More instructions",
					sections: { project: "Current project rules", temporary: null, style: "Style rules" },
					timestamp: 3,
				},
				{ role: "user", content: "new", timestamp: 4 },
			],
		});
		const result = buildPromptParts(context, true);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: {
				text: expect.stringContaining("# Pi session instructions\n\nBase instructions\n\nAdditional instructions\n\nMore instructions\n\nCurrent project rules\n\nStyle rules"),
			},
		});
		const serialized = JSON.stringify(result.prompt);
		expect(serialized).not.toContain("Old project rules");
		expect(serialized).not.toContain("Obsolete rules");
		expect(serialized).not.toContain("Tool result (undefined)");
	});

	it("truncates only history while preserving instructions intact", () => {
		const instructions = `  Start instructions\n${"important rule\n".repeat(3_000)}End instructions  `;
		const context = normalizeContext({
			systemPrompt: instructions,
			messages: [
				{ role: "user", content: `Old history start${"x".repeat(610_000)}Recent history end`, timestamp: 1 },
				{ role: "user", content: "new", timestamp: 2 },
			],
		});
		const result = buildPromptParts(context, true);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: { text: expect.stringContaining(`# Pi session instructions\n\n${instructions}\n\n---`) },
		});
		const serialized = JSON.stringify(result.prompt);
		expect(serialized).toContain("[truncated older context]");
		expect(serialized).toContain("Recent history end");
		expect(serialized).not.toContain("Old history start");
	});

	it("reconstructs trailing tools and sends the active request explicitly to a fresh session", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "inspect", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
					api: "antigravity-acp",
					provider: "antigravity-acp",
					model: "auto",
					usage: usageFromPrompt({ stopReason: "end_turn" }),
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const result = buildPromptParts(context, true);
		expect(result.prompt).toHaveLength(3);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: { text: expect.stringMatching(/tool call read[\s\S]*file contents/u) },
		});
		expect(result.prompt[1]).toMatchObject({ type: "text", text: expect.stringContaining("Continue") });
		expect(result.prompt[2]).toEqual({ type: "text", text: "inspect" });
	});

	it("replays transcript system sections separately from conversation history", () => {
		const context: Context = {
			messages: [
				{ role: "system", content: "Base instructions", sections: { rules: "Old rules", removed: "Obsolete" }, timestamp: 0 },
				{ role: "user", content: "old", timestamp: 1 },
				{ role: "system", content: "Additional instructions", sections: { rules: "New rules", removed: null }, timestamp: 2 },
				{ role: "user", content: "new", timestamp: 3 },
			],
		};
		const result = buildPromptParts(context, true);
		const block = result.prompt[0];
		if (block?.type !== "resource" || !("text" in block.resource)) throw new Error("missing context");
		expect(block.resource.text).toContain("Base instructions");
		expect(block.resource.text).toContain("Additional instructions");
		expect(block.resource.text).toContain("New rules");
		expect(block.resource.text).not.toContain("Old rules");
		expect(block.resource.text).not.toContain("Obsolete");
		expect(block.resource.text).not.toContain("Tool result (undefined");
		expect(result.prompt[1]).toEqual({ type: "text", text: "new" });
	});

	it("adds only unseen external deltas to a warm prompt", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "already owned", timestamp: 1 },
				{ role: "user", content: "externally inserted", timestamp: 2 },
				{ role: "user", content: "current", timestamp: 3 },
			],
		};
		const result = buildPromptParts(context, false, 1);
		expect(result.prompt).toHaveLength(2);
		expect(result.prompt[0]).toMatchObject({
			type: "resource",
			resource: { text: expect.stringContaining("externally inserted") },
		});
		expect(result.prompt[1]).toEqual({ type: "text", text: "current" });
	});

	it("drops rules that only repeat a bridged tool's schema", () => {
		const rawInstructions =
			"<rules>\n- Use bash for file operations\n" +
			"- Use edit for precise changes (edits[].oldText must match exactly)\n" +
			"- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls\n" +
			"- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.\n" +
			"- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.\n" +
			"- Use google_search when you need real-time, up-to-date web information, latest news, documentation, or fact checking.\n" +
			"- Pass specific URLs into the urls array if you want the search engine to fetch and analyze specific pages.\n" +
			"- Set instruction to provide special research directives from the lead agent (e.g. focus on issues, compare benchmarks, restrict time range).\n" +
			"</rules>";
		const context = normalizeContext({ systemPrompt: rawInstructions, messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		const text = (buildPromptParts(context, true).prompt[0] as { resource: { text: string } }).resource.text;
		const rules = /<rules>([\s\S]*)<\/rules>/u.exec(text)?.[1]?.trim().split("\n");
		expect(rules).toEqual([
			"- Use pi_bash for file operations",
			"- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		]);
	});

	it("routes images and Pi skills through Pi read while keeping other text reads native", () => {
		const rawInstructions =
			"<tools>\n- read: Read file contents\n- bash: Execute commands\n</tools>\n\n" +
			"<docs>\nPi documentation to strip\n</docs>\n\n" +
			"<rules>\n- Use bash for file operations\n- Use read to examine files instead of cat or sed.\n</rules>\n\n" +
			"<skills>\nUse the read tool to load a skill's file when the task matches its description.\n" +
			"When a skill file references a relative path, resolve it against the skill directory.\n" +
			"<available_skills><skill><name>libgen</name><location>/home/test/.pi/agent/skills/libgen/SKILL.md</location></skill></available_skills>\n</skills>";
		const context = normalizeContext({
			systemPrompt: rawInstructions,
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		const result = buildPromptParts(context, true);
		const text = (result.prompt[0] as { resource: { text: string } }).resource.text;
		expect(text).not.toContain("<docs>");
		expect(text).not.toContain("Pi documentation to strip");
		expect(text).not.toContain("<tools>");
		expect(text).not.toContain("- read: Read file contents");
		expect(text).toContain("- Use pi_bash for file operations");
		expect(text).toContain(PI_READ_EXAMINE_RULE);
		expect(text).not.toContain("view_file");
		expect(text).toContain("Use pi_read to load a skill's file when the task matches its description.");
		expect(text).toContain("Do not use Antigravity's native skill loader for these files.");
		expect(text).toContain("<location>/home/test/.pi/agent/skills/libgen/SKILL.md</location>");
		expect(text).toContain("When a skill file references a relative path, resolve it against the skill directory.");
		expect(text).not.toContain("Use the read tool to load a skill's file");
		expect(text).not.toContain("Use only for images");
	});
});

describe("instruction safety", () => {
	it("preserves instructions and untrusted-history labels despite long history", () => {
		const result = buildPromptParts({ systemPrompt: "  REQUIRED_PROJECT_RULE  ", messages: [
			{ role: "user", content: "x".repeat(610_000), timestamp: 1 },
			{ role: "user", content: "next", timestamp: 2 },
		]}, true);
		const text = JSON.stringify(result.prompt);
		expect(text).toContain("  REQUIRED_PROJECT_RULE  ");
		expect(text).toContain("untrusted conversation data");
		expect(text).toContain("truncated older context");
	});

	it("rejects oversized instructions instead of silently truncating them", () => {
		expect(() => buildPromptParts({ systemPrompt: "π".repeat(140_000), messages: [
			{ role: "user", content: "hello", timestamp: 1 },
		]}, true)).toThrow("system instructions exceed");
	});

	it("does not mistake a trailing system update for a tool result", () => {
		const result = buildPromptParts({ messages: [
			{ role: "user", content: "current request", timestamp: 1 },
			{ role: "system", content: "Updated rule", timestamp: 2 },
		]}, true);
		expect(result.prompt.at(-1)).toEqual({ type: "text", text: "current request" });
	});
});

describe("usageFromPrompt", () => {
	it("reads Gemini quota metadata without estimating", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			_meta: { quota: { token_count: { input_tokens: 11, output_tokens: 5 } } },
		});
		expect(usage).toMatchObject({ input: 11, output: 5, totalTokens: 16 });
	});

	it("maps standard ACP cache and thought counters", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			usage: {
				inputTokens: 20,
				outputTokens: 8,
				cachedReadTokens: 5,
				cachedWriteTokens: 2,
				thoughtTokens: 3,
				totalTokens: 28,
			},
		});
		expect(usage).toMatchObject({
			input: 15,
			output: 8,
			cacheRead: 5,
			cacheWrite: 2,
			reasoning: 3,
			totalTokens: 30,
		});
	});

	it("extracts quota metadata when the server supplies it", () => {
		expect(
			quotaFromPrompt({
				stopReason: "end_turn",
				_meta: {
					quota: {
						remainingQueries: 12,
						queryLimit: 100,
						resetTimestamp: 1_800_000_000,
						tier: "pro",
					},
				},
			}),
		).toMatchObject({ remaining: 12, limit: 100, tier: "pro" });
	});

	it("prefers the context-window measurement over turn-cumulative prompt counts", () => {
		// Antigravity 1.4.3 sums usage over every model call in the turn.
		const cumulative = usageFromPrompt({
			stopReason: "end_turn",
			usage: { inputTokens: 343_158, outputTokens: 5_231, cachedReadTokens: 273_253, totalTokens: 348_389 },
		});
		expect(withContextUsage(cumulative, 70_136).totalTokens).toBe(70_136);
		expect(withContextUsage(cumulative, undefined)).toBe(cumulative);
	});

	it("rejects malformed counts to zero", () => {
		const usage = usageFromPrompt({
			stopReason: "end_turn",
			_meta: { quota: { token_count: { input_tokens: -1, output_tokens: "9" } } },
		});
		expect(usage.totalTokens).toBe(0);
	});
});
