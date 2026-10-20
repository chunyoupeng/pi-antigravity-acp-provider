import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { inspectAntigravityAuth } from "../src/acp/antigravity.js";
import { describeCredentialStorage } from "../src/acp/credential-storage.js";
import { resolveAntigravityAcpEntry } from "../src/acp/process.js";
import {
	checkAntigravityAcpUpdate,
	inspectRuntimeSetup,
	updateAntigravityAcpRuntime,
} from "../src/acp/setup.js";
import {
	isPermissionMode,
	isRuntimeUpdateMode,
	isToolOwner,
	loadConfig,
	permissionModeLabel,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolOwner,
	type PermissionMode,
} from "../src/config.js";
import {
	ACP_PROTOCOL_VERSION,
	ACP_SDK_VERSION,
	PACKAGE_VERSION,
} from "../src/constants.js";
import { createAntigravityProvider } from "../src/provider.js";
import {
	AntigravityRuntime,
	MANAGED_AUTH_MARKER,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
	type PermissionToolResult,
} from "../src/runtime.js";
import { pruneAcpHistory } from "../src/acp/history-cleanup.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { runSetupWizard } from "../src/wizard.js";
import { fetchUsage, formatUsage } from "../src/usage.js";
import { registerToolActivity } from "./tool-activity.js";
import { createSafeBashToolDefinition, createSafeReadToolDefinition } from "./safe-read.js";

// Pi may start several sessions in one process; prune once.
let historyPruned = false;

export default function antigravityAcpExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const runtime = new AntigravityRuntime(
		undefined, config.permissions, undefined, registerToolActivity(pi), config.tools,
	);
	const { provider } = createAntigravityProvider(runtime);
	pi.registerProvider(provider);
	pi.registerTool(createSafeReadToolDefinition(process.cwd()));
	pi.registerTool(createSafeBashToolDefinition(process.cwd()));

	pi.registerTool({
		name: PERMISSION_TOOL_NAME,
		label: "Antigravity ACP Permission",
		description: "Presents an Antigravity ACP permission request to the user. Only call IDs emitted by the provider are valid.",
		parameters: Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }) }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const request = runtime.getPermission(params.requestId);
			if (!request) throw new Error("This Antigravity permission request is missing, expired, or already used");
			const labels = request.options.map(
				(option, index) => `${index + 1}. ${option.label} [${option.kind.replaceAll("_", " ")}]`,
			);
			let selected: string | undefined;
			try {
				selected = await ctx.ui.select(request.title, labels);
			} catch {
				// Print/RPC/headless modes deny when no interactive selector is available.
			}
			const selectedIndex = selected === undefined ? -1 : labels.indexOf(selected);
			const optionId = selectedIndex < 0 ? undefined : request.options[selectedIndex]?.id;
			const details: PermissionToolResult = {
				kind: PERMISSION_RESULT_KIND,
				requestId: request.id,
				...(optionId === undefined ? {} : { optionId }),
				cancelled: optionId === undefined,
			};
			return {
				content: [
					{
						type: "text",
						text: optionId === undefined ? "Permission denied." : `Permission decision recorded: ${selected}`,
					},
				],
				details,
			};
		},
	});

	const commandDefinition = {
		description: "Set up, inspect, update, or configure Google Antigravity ACP",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = args.trim() || "doctor";
			if (command === "setup") {
				await runSetupWizard(ctx.ui, runtime);
				return;
			}
			if (command === "update" || command === "update-runtime") {
				const result = await updateAntigravityAcpRuntime((message) => ctx.ui.notify(message, "info"));
				ctx.ui.notify(
					result.changed
						? `Installed verified Antigravity ACP ${result.version}. Restart Pi to move active sessions to it.`
						: `Antigravity ACP ${result.version} is already the latest signed release.`,
					"info",
				);
				return;
			}
			if (command === "updates" || command.startsWith("updates ")) {
				const requested = command.slice("updates".length).trim();
				if (!requested) {
					ctx.ui.notify(`Antigravity runtime updates: ${loadConfig().runtimeUpdates}`, "info");
					return;
				}
				if (!isRuntimeUpdateMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp updates [automatic|notify|manual]",
						"warning",
					);
					return;
				}
				saveRuntimeUpdateMode(requested);
				ctx.ui.notify(`Antigravity runtime updates: ${requested}`, "info");
				return;
			}
			if (command === "logout" || command === "account" || command === "switch-account") {
				const { server } = await runtime.logout();
				ctx.ui.notify(
					`${server ? "Antigravity signed out and cleared its stored credentials" : "Local Antigravity credentials were cleared"}; saved ACP sessions were forgotten. Run /logout for the old Pi marker, then /login to choose the next account.`,
					"info",
				);
				return;
			}
			if (command === "tools" || command.startsWith("tools ")) {
				const requested = command.slice("tools".length).trim();
				if (!requested) {
					ctx.ui.notify(`Antigravity tool owner: ${loadConfig().tools}`, "info");
					return;
				}
				if (!isToolOwner(requested)) {
					ctx.ui.notify("Usage: /antigravity-acp tools [pi|native]", "warning");
					return;
				}
				runtime.setToolOwner(requested);
				saveToolOwner(requested);
				ctx.ui.notify(
					requested === "pi"
						? "Antigravity uses Pi's tools for files and the shell (from the next prompt)."
						: "Antigravity uses its built-in tools; file reads and writes still go through Pi (from the next prompt).",
					"info",
				);
				return;
			}
			if (command === "sessions") {
				const sessions = await runtime.listSessions(ctx.cwd);
				if (sessions.length === 0) {
					ctx.ui.notify(`No Antigravity sessions for ${ctx.cwd}`, "info");
					return;
				}
				const labels = sessions.map((session) =>
					`${session.sessionId}${session.updatedAt ? `  ${session.updatedAt}` : ""}${session.title && !session.title.includes(session.sessionId.slice(0, 8)) ? `  ${session.title}` : ""}`,
				);
				const selected = await ctx.ui.select("Attach an Antigravity session to this Pi session", labels);
				const session = selected === undefined ? undefined : sessions[labels.indexOf(selected)];
				if (!session) return;
				await runtime.attachSession(ctx.sessionManager.getSessionId(), session.sessionId, ctx.cwd);
				ctx.ui.notify(`The next prompt resumes Antigravity session ${session.sessionId}.`, "info");
				return;
			}
			if (command === "plan" || command.startsWith("plan ")) {
				const task = command.slice("plan".length).trim();
				if (!task) {
					ctx.ui.notify("Usage: /antigravity-acp plan <task>", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current turn to finish first.", "warning");
					return;
				}
				// Antigravity's built-in /plan: it writes an implementation plan and
				// asks for approval before it executes.
				pi.sendUserMessage(`/plan ${task}`, { expandPromptTemplates: false });
				return;
			}
			if (command === "usage") {
				try {
					ctx.ui.notify(formatUsage(await fetchUsage()), "info");
				} catch (error) {
					ctx.ui.notify(
						`Could not read Antigravity usage: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return;
			}
			if (command === "quota") {
				const metrics = (await runtime.snapshot()).metrics;
				ctx.ui.notify(formatMetrics(metrics), "info");
				return;
			}
			if (command === "qualify") {
				await runSetupWizard(ctx.ui, runtime);
				return;
			}
			if (command === "permissions" || command.startsWith("permissions ")) {
				let requested = command.slice("permissions".length).trim().replaceAll("-", "_");
				if (!requested) {
					const choices = [
						"yolo — allow commands and edits automatically (default)",
						"auto-edit — allow edits automatically; commands may ask",
						"default — ask before sensitive operations",
					];
					const selected = await ctx.ui.select("Antigravity permission mode", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!.replaceAll("-", "_");
				}
				if (!isPermissionMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp permissions [default|auto-edit|yolo]",
						"warning",
					);
					return;
				}
				const mode: PermissionMode = requested;
				await runtime.setPermissionMode(mode);
				savePermissionMode(mode);
				ctx.ui.notify(
					mode === "yolo"
						? "Antigravity permission mode: yolo. Commands and edits may run without confirmation."
						: `Antigravity permission mode: ${permissionModeLabel(mode)}.`,
					mode === "yolo" ? "warning" : "info",
				);
				return;
			}
			const verbose = command === "doctor --verbose";
			if (command !== "doctor" && command !== "status" && !verbose) {
				ctx.ui.notify(
					"Usage: /antigravity-acp [setup|doctor|status|usage|quota|update|updates|logout|account|qualify|permissions|tools|sessions|plan]",
					"warning",
				);
				return;
			}
			let entry: string;
			try {
				entry = resolveAntigravityAcpEntry();
			} catch (error) {
				entry = error instanceof Error ? error.message : String(error);
			}
			const snapshot = await runtime.snapshot(verbose);
			const auth = inspectAntigravityAuth();
			const setup = inspectRuntimeSetup();
			const update = await checkAntigravityAcpUpdate().catch(() => undefined);
			ctx.ui.notify(
				[
					`Antigravity ACP provider ${PACKAGE_VERSION}`,
					`Runtime: installed=${setup.installedVersion ?? "external/unknown"} approved=${update?.approvedVersion ?? setup.approvedVersion} registry=${update?.latestVersion ?? "unavailable"} updates=${setup.updateMode}; ACP SDK ${ACP_SDK_VERSION}, protocol ${ACP_PROTOCOL_VERSION}`,
					`Antigravity server: ${entry}`,
					`Authentication: ${auth.status}${auth.authType ? ` (${auth.authType})` : ""}${auth.credentialStore ? ` [${auth.credentialStore}]` : ""}`,
					`Credential storage (preflight): ${describeCredentialStorage()}`,
					`Requested permission mode: ${permissionModeLabel(snapshot.permissionMode)}`,
					`Tool owner: ${snapshot.toolOwner}`,
					`Active bindings: ${snapshot.bindings}`,
					formatMetrics(snapshot.metrics),
					...snapshot.processes.flatMap((item) => [
						`• pid=${item.pid ?? "?"} generation=${item.generation} model=${item.modelId} confirmedMode=${item.confirmedPermissionMode} alive=${item.alive} restored=${item.restored} agent=${item.agentVersion ?? "?"} mcpHttp=${item.mcpHttp} piTools=${item.piOwnsTools} context=${item.contextTokens ?? "?"} permission=${item.waitingForPermission} tools=${item.waitingForTools} ignoredStdoutNoise=${item.ignoredStdoutNoiseLines}`,
						`  omitted Pi tools: ${item.omittedTools.length ? item.omittedTools.map((tool) => `${tool.name} (${tool.reason})`).join("; ") : "none"}`,
						...(verbose && item.stderrTail ? [`  stderr (redacted): ${item.stderrTail}`] : []),
					]),
				].join("\n"),
				"info",
			);
		},
	};
	pi.registerCommand("antigravity-acp", commandDefinition);
	pi.registerCommand("gemini-acp", {
		...commandDefinition,
		description: "Deprecated alias for /antigravity-acp",
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!historyPruned) {
			historyPruned = true;
			try {
				pruneAcpHistory(new AcpSessionStore().acpSessionIds());
			} catch {
				// History cleanup is housekeeping and must not interrupt Pi startup.
			}
		}
		try {
			const auth = inspectAntigravityAuth();
			if (auth.status === "api-key-env" || auth.status === "oauth-refreshable") {
				const apiKey = auth.status === "oauth-refreshable" ? MANAGED_AUTH_MARKER : process.env.GEMINI_API_KEY;
				void runtime.prewarm(apiKey).catch(() => undefined);
			}
		} catch {
			// Background prewarming is best-effort and must not interrupt Pi startup.
		}
		if (loadConfig().runtimeUpdates !== "notify") return;
		try {
			const update = await checkAntigravityAcpUpdate();
			if (update.approvalPending) {
				ctx.ui.notify(
					`Antigravity ACP ${update.latestVersion} is published but is still awaiting a signed runtime manifest.`,
					"warning",
				);
			} else if (update.updateAvailable) {
				ctx.ui.notify(
					update.managed
						? `Antigravity ACP ${update.approvedVersion} is available. Run /antigravity-acp update.`
						: `Antigravity ACP ${update.approvedVersion} is available, but the selected external runtime must be updated manually.`,
					"info",
				);
			}
		} catch {
			// Update checks are advisory and must not interrupt Pi startup.
		}
	});

	pi.on("session_shutdown", async () => {
		await runtime.close();
	});
}

function formatMetrics(metrics: {
	totals: {
		turns: number;
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
	latestQuota?: { remaining?: number; limit?: number; resetAt?: string; tier?: string; model?: string };
	latestContext?: { used: number; size: number };
}): string {
	const totalTokens =
		metrics.totals.input +
		metrics.totals.output +
		metrics.totals.reasoning +
		metrics.totals.cacheRead +
		metrics.totals.cacheWrite;
	const quota = metrics.latestQuota;
	const context = metrics.latestContext;
	return [
		`Usage this process: turns=${metrics.totals.turns} tokens=${totalTokens} input=${metrics.totals.input} output=${metrics.totals.output} reasoning=${metrics.totals.reasoning} cacheRead=${metrics.totals.cacheRead}`,
		quota
			? `Latest quota: remaining=${quota.remaining ?? "unknown"}/${quota.limit ?? "unknown"} reset=${quota.resetAt ?? "unknown"} tier=${quota.tier ?? "unknown"} model=${quota.model ?? "unknown"}`
			: "Latest quota: not supplied by the Antigravity server",
		context
			? `Latest context: ${context.used}/${context.size} tokens (${((context.used / context.size) * 100).toFixed(1)}%)`
			: "Latest context: no usage_update received yet",
	].join("\n");
}
