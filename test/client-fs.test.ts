import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readClientTextFile, writeClientTextFile } from "../src/acp/client-fs.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-fs-")));
	directories.push(directory);
	return directory;
}

describe("client fs", () => {
	it("reads whole files and line windows", async () => {
		const root = workspace();
		const file = path.join(root, "a.txt");
		fs.writeFileSync(file, "1\n2\n3\n4");
		expect(await readClientTextFile({ sessionId: "s", path: file }, [root])).toEqual({ content: "1\n2\n3\n4" });
		expect(await readClientTextFile({ sessionId: "s", path: file, line: 2, limit: 2 }, [root])).toEqual({ content: "2\n3" });
	});

	it("writes atomically, creates parents and keeps the file mode", async () => {
		const root = workspace();
		const file = path.join(root, "deep", "b.sh");
		await writeClientTextFile({ sessionId: "s", path: file, content: "first" }, [root]);
		fs.chmodSync(file, 0o755);
		await writeClientTextFile({ sessionId: "s", path: file, content: "second" }, [root]);
		expect(fs.readFileSync(file, "utf8")).toBe("second");
		expect(fs.statSync(file).mode & 0o777).toBe(0o755);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["b.sh"]);
	});

	it("rejects relative paths, other roots and symlink escapes", async () => {
		const root = workspace();
		const other = workspace();
		fs.writeFileSync(path.join(other, "secret.txt"), "secret");
		fs.symlinkSync(other, path.join(root, "link"));
		await expect(readClientTextFile({ sessionId: "s", path: "a.txt" }, [root])).rejects.toThrow(/absolute/u);
		await expect(readClientTextFile({ sessionId: "s", path: path.join(other, "secret.txt") }, [root])).rejects.toThrow(/outside/u);
		await expect(readClientTextFile({ sessionId: "s", path: path.join(root, "link", "secret.txt") }, [root])).rejects.toThrow(/outside/u);
		await expect(
			writeClientTextFile({ sessionId: "s", path: path.join(root, "link", "new.txt"), content: "x" }, [root]),
		).rejects.toThrow(/outside/u);
		expect(fs.existsSync(path.join(other, "new.txt"))).toBe(false);
	});

	it("maps a missing file to resource-not-found", async () => {
		const root = workspace();
		await expect(readClientTextFile({ sessionId: "s", path: path.join(root, "missing.txt") }, [root])).rejects.toMatchObject({ code: -32002 });
	});
});
