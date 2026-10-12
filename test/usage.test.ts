import { describe, expect, it } from "vitest";

import { formatUsage, parseUsageOutput } from "../src/usage.js";

const SAMPLE = [
	"Gemini Models\tWeekly Limit Remaining\t92%\t2026-10-14T06:38:06Z",
	"Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-11T13:02:48Z",
	"Claude and GPT models\tWeekly Limit Remaining\t4%\t2026-10-14T06:40:04Z",
	"Claude and GPT models\tFive Hour Limit Remaining\t98%\t2026-10-11T14:10:03Z",
].join("\r\n");

describe("parseUsageOutput", () => {
	it("parses weekly and five-hour limits", () => {
		const limits = parseUsageOutput(SAMPLE);
		expect(limits).toHaveLength(4);
		expect(limits[2]).toEqual({
			group: "Claude and GPT models",
			window: "Weekly Limit Remaining",
			remainingPercent: 4,
			resetAt: "2026-10-14T06:40:04Z",
		});
	});

	it("ignores unrelated or malformed lines", () => {
		expect(parseUsageOutput("hello\nA\tB\tnope\t2026-10-14T06:40:04Z\nA\tB\t5%\tnot-a-date")).toEqual([]);
	});
});

describe("formatUsage", () => {
	it("lists each limit with its remaining percentage", () => {
		const text = formatUsage(parseUsageOutput(SAMPLE), new Date("2026-10-11T09:13:00Z"));
		expect(text).toContain("Claude and GPT models — Weekly Limit Remaining: 4% left");
		expect(text).toContain("Gemini Models — Five Hour Limit Remaining: 99% left");
	});
});
