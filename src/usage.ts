import { execFile } from "node:child_process";

export interface UsageLimit {
	group: string;
	window: string;
	remainingPercent: number;
	resetAt: string;
}

const USAGE_TIMEOUT_MS = 30_000;

/**
 * Parses the tab-separated output of `agy -p "/usage"`:
 * `<model group>\t<window>\t<NN%>\t<ISO reset time>`.
 * Unrecognised lines are ignored so extra CLI chatter cannot break parsing.
 */
export function parseUsageOutput(output: string): UsageLimit[] {
	const limits: UsageLimit[] = [];
	for (const line of output.split(/\r?\n/)) {
		const [group, window, percent, resetAt] = line.split("\t").map((part) => part.trim());
		if (!group || !window || !percent || !resetAt) continue;
		const match = /^(\d+(?:\.\d+)?)%$/.exec(percent);
		if (!match || Number.isNaN(Date.parse(resetAt))) continue;
		limits.push({ group, window, remainingPercent: Number(match[1]), resetAt });
	}
	return limits;
}

/** Runs the Antigravity CLI's non-interactive `/usage` command. */
export function fetchUsage(command = "agy", timeoutMs = USAGE_TIMEOUT_MS): Promise<UsageLimit[]> {
	return new Promise((resolve, reject) => {
		execFile(command, ["-p", "/usage"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(
					(error as NodeJS.ErrnoException).code === "ENOENT"
						? new Error(`Could not find the \`${command}\` CLI on PATH; install Antigravity CLI to query usage.`)
						: error,
				);
				return;
			}
			const limits = parseUsageOutput(stdout);
			if (limits.length === 0) {
				reject(new Error("`agy /usage` returned no recognisable limits. Make sure you are logged in with `agy`."));
				return;
			}
			resolve(limits);
		});
	});
}

/** Formats limits for display, with reset times in the local time zone. */
export function formatUsage(limits: UsageLimit[], now = new Date()): string {
	const lines = ["Antigravity usage limits:"];
	for (const limit of limits) {
		const reset = new Date(limit.resetAt);
		const minutes = Math.max(0, Math.round((reset.getTime() - now.getTime()) / 60_000));
		const eta = minutes >= 1440 ? `${(minutes / 1440).toFixed(1)}d` : minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`;
		lines.push(
			`• ${limit.group} — ${limit.window}: ${limit.remainingPercent}% left, resets ${reset.toLocaleString()} (in ${eta})`,
		);
	}
	return lines.join("\n");
}
