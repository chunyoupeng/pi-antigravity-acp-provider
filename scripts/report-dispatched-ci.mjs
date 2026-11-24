import { execFileSync } from "node:child_process";

const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_SHA: sha } = process.env;
if (repo !== "chunyoupeng/pi-antigravity-acp-provider" || !/^\d+$/u.test(runId ?? "") || !/^[0-9a-f]{40}$/u.test(sha ?? "")) {
	throw new Error("CI reporting requires the official repository and exact Actions run/commit identity");
}
const api = (...args) => execFileSync("gh", ["api", ...args], { encoding: "utf8", timeout: 60_000 }).trim();
const run = JSON.parse(api(`repos/${repo}/actions/runs/${runId}`));
if (run.id !== Number(runId) || run.head_sha !== sha || run.event !== "workflow_dispatch") {
	throw new Error("Refusing to report results for a different run, commit or event");
}
const { jobs } = JSON.parse(api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`));
for (const name of ["Check (22.19.0)", "Check (24)"]) {
	const job = jobs.find((entry) => entry.name === name);
	// Mirror the actual completed validation job, never the reporting job itself.
	const state = job?.status === "completed" && job.conclusion === "success" ? "success" : "failure";
	const target = job?.html_url ?? run.html_url;
	if (!target?.startsWith(`https://github.com/${repo}/actions/runs/${runId}`)) throw new Error("Unexpected CI job URL");
	api("--method", "POST", `repos/${repo}/statuses/${sha}`,
		"-f", `context=${name}`, "-f", `state=${state}`, "-f", `target_url=${target}`,
		"-f", `description=Actual validation job: ${job?.conclusion ?? "missing"}`);
	console.log(`${name}: ${state} (${target})`);
}
