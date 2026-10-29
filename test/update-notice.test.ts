import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	formatRuntimeUpdateNotice,
	recordRuntimeUpdateNotice,
	setRuntimeUpdateNoticeListener,
	takeRuntimeUpdateNotices,
} from "../src/acp/update-notice.js";

function tempFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-notice-")), "nested", "notice.json");
}

describe("runtime update notices", () => {
	afterEach(() => setRuntimeUpdateNoticeListener(undefined));

	it("keeps a notice for the next start and shows it only once", () => {
		const file = tempFile();
		recordRuntimeUpdateNotice({ kind: "updated", from: "1.4.3", to: "1.4.4", at: 1 }, file);
		const notices = takeRuntimeUpdateNotices(file);
		expect(notices).toEqual([{ kind: "updated", from: "1.4.3", to: "1.4.4", at: 1 }]);
		expect(formatRuntimeUpdateNotice(notices[0]!)).toContain("1.4.3 → 1.4.4");
		expect(takeRuntimeUpdateNotices(file)).toEqual([]);
	});

	it("delivers straight to a live session instead of persisting", () => {
		const file = tempFile();
		const seen = vi.fn();
		setRuntimeUpdateNoticeListener(seen);
		recordRuntimeUpdateNotice({ kind: "failed", to: "1.4.4", error: "disk full", at: 2 }, file);
		expect(seen).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed", error: "disk full" }));
		expect(takeRuntimeUpdateNotices(file)).toEqual([]);
	});

	it("persists when the live session cannot show it", () => {
		const file = tempFile();
		setRuntimeUpdateNoticeListener(() => {
			throw new Error("gone");
		});
		recordRuntimeUpdateNotice({ kind: "failed", to: "1.4.4", error: "x", at: 3 }, file);
		expect(takeRuntimeUpdateNotices(file)).toHaveLength(1);
	});

	it("deduplicates repeated failures for the same version and ignores corrupt files", () => {
		const file = tempFile();
		recordRuntimeUpdateNotice({ kind: "failed", to: "1.4.4", error: "a", at: 1 }, file);
		recordRuntimeUpdateNotice({ kind: "failed", to: "1.4.4", error: "b", at: 2 }, file);
		expect(takeRuntimeUpdateNotices(file)).toEqual([{ kind: "failed", to: "1.4.4", error: "b", at: 2 }]);
		fs.writeFileSync(file, "{not json");
		expect(takeRuntimeUpdateNotices(file)).toEqual([]);
	});
});
