import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-antigravity-acp-pack-"));
let tarball;

try {
	const name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
	const output = JSON.parse(execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8" }));
	// npm 12 keys pack results by package name; earlier versions return an array.
	const packed = Array.isArray(output) ? output[0] : output[name];
	if (!packed?.filename) throw new Error("npm pack did not return a tarball filename");
	tarball = path.join(root, packed.filename);
	fs.writeFileSync(path.join(temporary, "package.json"), '{"private":true}\n');
	execFileSync(
		"npm",
		["install", "--ignore-scripts", "--legacy-peer-deps", tarball],
		{ cwd: temporary, stdio: "inherit" },
	);
	const installed = path.join(temporary, "node_modules", ...name.split("/"));
	for (const required of ["extensions/index.ts", "src/acp/supervisor.mjs", "src/mcp/bridge.ts"]) {
		if (!fs.existsSync(path.join(installed, required))) throw new Error(`Packed file is missing: ${required}`);
	}
	const unzipperPackage = path.join(temporary, "node_modules", "unzipper", "package.json");
	if (!fs.existsSync(unzipperPackage)) throw new Error("Antigravity ACP installer dependency is missing");
	const models = execFileSync(
		"pi",
		[
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--offline",
			"-e",
			path.join(installed, "extensions/index.ts"),
			"--list-models",
			"antigravity-acp",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
				GEMINI_API_KEY: "packed-smoke-placeholder",
			},
		},
	);
	if (!models.includes("antigravity-acp")) throw new Error("Packed extension did not register Antigravity models");
	process.stdout.write("Packed install passed with Antigravity ACP setup support.\n");
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
	if (tarball) fs.rmSync(tarball, { force: true });
}
