import {
	RequestError,
	type ContentBlock,
	type InitializeResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionInfo,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	clearAntigravityCredentials,
	clearKeychainCredentials,
	inspectAntigravityAuth,
	type AntigravityAuthHealth,
} from "./acp/antigravity.js";
import { clientFileRoots, readClientTextFile, writeClientTextFile } from "./acp/client-fs.js";
import {
	AntigravityAcpConnection,
	type AntigravityConnectionOptions,
	type SessionMeta,
} from "./acp/connection.js";
import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.js";
import { AcpSessionStore } from "./acp/session-store.js";
import { contextTokensInUse, transcriptCheckpoints } from "./acp/transcript-usage.js";
import { sessionModels, sessionModes, type AcpModelInfo, type AcpNewSessionResponse, type SessionState } from "./acp/session-state.js";
import {
	MANAGED_AUTH_MARKER,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
} from "./constants.js";
export { MANAGED_AUTH_MARKER, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME } from "./constants.js";
import { AcpToolTracker, type AcpToolActivity, mapSessionUpdate, toolActivityDetails } from "./acp/events.js";
import { ensureAntigravityAcpReady } from "./acp/setup.js";
import { HeadlessOAuthRelay, shouldUseHeadlessOAuth } from "./acp/headless-oauth.js";
import {
	BRIDGE_NAME,
	PiMcpBridge,
	piToolFingerprint,
	planToolProjection,
	type ToolOmission,
	type PiToolInvocation,
} from "./mcp/bridge.js";
import type { PermissionMode, ToolOwner } from "./config.js";
import { MAX_TEXT_RESULT_BYTES, MCP_MAX_OUTPUT_BYTES, resolveAcpModelId, resolveAcpThinking } from "./models.js";
import { PI_BASH_DESCRIPTION, PI_READ_DESCRIPTION, type PromptParts, buildPromptParts, currentSystemInstructions } from "./stream/context.js";
import { PiEventWriter } from "./stream/pi-events.js";
import { contextUsage, usageFromPrompt, withContextUsage } from "./stream/usage.js";
import { RuntimeMetrics } from "./status.js";

const PERMISSION_TIMEOUT_MS = 120_000;
const TOOL_BATCH_MS = 100;
/** Antigravity abandons an MCP call after 3 minutes and the model reads that
 * as a failure. A Pi tool still running before then is handed off instead:
 * the model ends its turn and gets the result as the next prompt. */
const TOOL_HANDOFF_MS = 150_000;

/** Antigravity built-ins disabled when Pi owns tool execution. The model then
 * reads, runs commands and changes files only through Pi's bridged tools, so
 * Pi's tool set, hooks and rendering apply. `start_subagent` also removes
 * invoke_subagent, define_subagent, manage_subagents and send_message, so
 * subagents cannot read or run outside Pi. Web search and URL fetch have no Pi
 * equivalent and stay native. */
export const PI_OWNED_NATIVE_TOOLS = [
	"view_file",
	"run_command",
	"create_file",
	"edit_file",
	"list_directory",
	"search_directory",
	"find_file",
	"start_subagent",
] as const;

/** Pi tool descriptions replaced when Pi owns tools: they state the 46 KiB
 * page and argument list that the lazy-loaded MCP schema would otherwise hold. */
export const PI_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	read: PI_READ_DESCRIPTION,
	bash: PI_BASH_DESCRIPTION,
};

/** Antigravity built-ins disabled in every tool mode. Each one costs prompt
 * tokens on every turn (schedule alone about 2k) and has no use behind Pi. */
export const UNUSED_NATIVE_TOOLS = ["schedule", "ask_question", "generate_image"] as const;

type AntigravityModel = Model<"antigravity-acp">;

interface PendingPermission {
	id: string;
	request: RequestPermissionRequest;
	resolve: (response: RequestPermissionResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingPiTool {
	invocation: PiToolInvocation;
	/** Resolve the MCP request and release its bounded work-watchdog hold. */
	resolve: (result: CallToolResult) => void;
	/** Antigravity dropped the MCP request; Pi's result must go out as a prompt. */
	abandoned: boolean;
}

/** A Pi tool result that arrived after Antigravity abandoned its MCP call. */
interface LateResult {
	toolName: string;
	result: ToolResultMessage;
}

interface Binding {
	key: string;
	cwd: string;
	connection: AntigravityAcpConnection;
	initialize: InitializeResponse;
	session: AcpNewSessionResponse;
	mode: PermissionMode;
	instructionsFingerprint: string | undefined;
	needsReconstruction: boolean;
	modelId: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint: string | undefined;
	pendingContextCount: number;
	pendingContextFingerprint: string;
	writer: PiEventWriter | undefined;
	permission: PendingPermission | undefined;
	pendingTools: Map<string, PendingPiTool>;
	lateResults: LateResult[];
	toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
	bridge: PiMcpBridge | undefined;
	toolFingerprint: string;
	omittedTools: ToolOmission[];
	toolTracker: AcpToolTracker;
	updateQueue: Promise<void>;
	turnCompletion: Promise<void> | undefined;
	abortRequested: boolean;
	piSessionId: string | undefined;
	restored: boolean;
	toolOwner: ToolOwner;
	/** True when the Antigravity built-ins in PI_OWNED_NATIVE_TOOLS are disabled. */
	piOwnsTools: boolean;
	contextTokens: number | undefined;
	/** Harness checkpoints already in the transcript when this binding first saw it. */
	harnessCheckpoints: number | undefined;
	/** The harness replaced this session's history with its own summary. */
	harnessCheckpointed: boolean;
}

export interface PermissionView {
	id: string;
	title: string;
	options: Array<{ id: string; label: string; kind: string }>;
}

export interface ManualGoogleLoginInteraction {
	showAuthorizationUrl: (url: string, instructions: string) => void;
	promptForCallback: (signal: AbortSignal) => Promise<string>;
}

export interface PermissionToolResult {
	kind: typeof PERMISSION_RESULT_KIND;
	requestId: string;
	optionId?: string;
	cancelled: boolean;
}

export interface RuntimeSnapshot {
	bindings: number;
	permissionMode: PermissionMode;
	toolOwner: ToolOwner;
	metrics: ReturnType<RuntimeMetrics["snapshot"]>;
	processes: Array<{
		key: string;
		pid?: number;
		generation: number;
		sessionId: string;
		modelId: string;
		confirmedPermissionMode: PermissionMode;
		omittedTools: ToolOmission[];
		alive: boolean;
		waitingForPermission: boolean;
		waitingForTools: number;
		agentVersion: string | undefined;
		mcpHttp: boolean;
		restored: boolean;
		piOwnsTools: boolean;
		contextTokens?: number;
		ignoredStdoutNoiseLines: number;
		stderrTail?: string;
	}>;
}

export type AntigravityConnectionFactory = (options: AntigravityConnectionOptions) => AntigravityAcpConnection;

export class AntigravityRuntime {
	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	private disposed = false;
	private closePromise: Promise<void> | undefined;
	private bindingEpoch = 0;
	private readonly activeConnections = new Set<AntigravityAcpConnection>();
	private readonly queues = new Map<string, Promise<void>>();
	private modeChanges = Promise.resolve();

	private readonly connectionFactory: AntigravityConnectionFactory;
	private readonly ensureAgent: boolean;
	private readonly sessionStore: AcpSessionStore | undefined;
	private readonly metrics = new RuntimeMetrics();
	private permissionMode: PermissionMode;
	private toolOwner: ToolOwner;

	constructor(
		connectionFactory?: AntigravityConnectionFactory,
		permissionMode: PermissionMode = "yolo",
		sessionStore?: AcpSessionStore,
		private readonly onToolActivity?: (activity: AcpToolActivity) => void,
		toolOwner: ToolOwner = "pi",
		private readonly toolHandoffMs = TOOL_HANDOFF_MS,
	) {
		this.toolOwner = toolOwner;
		this.connectionFactory = connectionFactory ?? ((options) => new AntigravityAcpConnection(options));
		this.ensureAgent = connectionFactory === undefined;
		this.permissionMode = permissionMode;
		this.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
	}

	stream(model: AntigravityModel, context: Context, options: SimpleStreamOptions = {}): PiEventWriter {
		const writer = new PiEventWriter(model, options);
		// ACP has no mid-conversation system-message API. Replay Pi's prompt/tool
		// deltas into a checkpoint; its fingerprint invalidates stale warm sessions.
		try {
			const transcript = collapseSystemMessages(normalizeContext(context));
			const resolvedContext: Context = {
				messages: transcript.messages,
				systemPrompt: getCurrentSystemPrompt(transcript.messages),
				tools: getCurrentTools(transcript.messages),
			};
			currentSystemInstructions(resolvedContext);
			void this.runQueued(model, resolvedContext, options, writer).catch((error: unknown) => {
				writer.fail(error, options.signal?.aborted === true || isAbort(error));
			});
		} catch (error) {
			writer.fail(error, options.signal?.aborted === true || isAbort(error));
		}
		return writer;
	}

	async discoverModels(apiKey: string | undefined, signal?: AbortSignal): Promise<AcpModelInfo[]> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (signal?.aborted) throw abortError();
		if (this.ensureAgent) await ensureAntigravityAcpReady(undefined, signal);
		if (signal?.aborted) throw abortError();
		this.assertEpoch(epoch);
		const connection = this.createConnection({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const session = await connection.newSession(process.cwd(), signal);
			this.assertEpoch(epoch);
			// The legacy list keeps one entry per thinking-level variant; Antigravity
			// 1.4's model selector folds them into families.
			return session.models?.availableModels ?? sessionModels(session)?.availableModels ?? [];
		} finally {
			await connection.close();
		}
	}

	async loginGoogle(
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
		manualInteraction?: ManualGoogleLoginInteraction,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress, signal);
		this.assertEpoch(epoch);
		const useManualOAuth = manualInteraction !== undefined && shouldUseHeadlessOAuth();
		const relay = useManualOAuth ? new HeadlessOAuthRelay() : undefined;
		const connection = this.createConnection({
			cwd: process.cwd(),
			...(relay ? { env: relay.env } : {}),
		});
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			const method = initialize.authMethods?.find((candidate) =>
				/log\s*in\s+with\s+google|google\s+account|oauth-personal/iu.test(
					`${candidate.id} ${candidate.name}`,
				),
			);
			if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise Google login");
			const authentication = connection.authenticate(
				{ methodId: method.id },
				signal,
				relay ? 10 * 60_000 : undefined,
			);
			void authentication.catch(() => undefined);
			if (relay && manualInteraction) {
				const captured = await raceAuthentication(relay.waitForAuthorization(signal), authentication);
				if (captured.authenticated) {
					onProgress?.("Antigravity reused the saved Google login.");
				} else {
					const instructions =
						"Open this URL in a browser on your local machine. After Google redirects to localhost, the page may fail to load; copy the complete localhost URL from the browser address bar and paste it below.";
					manualInteraction.showAuthorizationUrl(captured.value.url, instructions);
					const promptController = new AbortController();
					let entered: Awaited<ReturnType<typeof raceAuthentication<string>>>;
					try {
						entered = await raceAuthentication(
							manualInteraction.promptForCallback(promptController.signal),
							authentication,
						);
					} catch (error) {
						promptController.abort();
						throw error;
					}
					if (entered.authenticated) {
						promptController.abort();
					} else {
						await relay.forwardCallback(entered.value, captured.value, signal);
					}
				}
			}
			await authentication;
			this.assertEpoch(epoch);
			await connection.newSession(process.cwd(), signal);
			this.assertEpoch(epoch);
		} finally {
			relay?.dispose();
			await connection.close();
		}
	}

	async verifyApiKey(
		apiKey: string,
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress, signal);
		this.assertEpoch(epoch);
		const connection = this.createConnection({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			await connection.newSession(process.cwd(), signal);
			this.assertEpoch(epoch);
		} finally {
			await connection.close();
		}
	}

	async authHealth(apiKey?: string): Promise<AntigravityAuthHealth & { networkValid?: boolean; error?: string }> {
		const local = inspectAntigravityAuth();
		try {
			await this.discoverModels(apiKey ?? (hasUsableLocalAuth(local) ? MANAGED_AUTH_MARKER : undefined));
			return { ...local, networkValid: true };
		} catch (error) {
			return { ...local, networkValid: false, error: errorMessage(error) };
		}
	}

	/** Signs out through the server's ACP `logout` (which also clears Keychain
	 * tokens), then removes local state. Returns whether the server did it. */
	async logout(signal?: AbortSignal): Promise<{ server: boolean }> {
		this.assertActive();
		await this.closeBindings();
		this.sessionStore?.clear();
		let server = false;
		try {
			const connection = this.createConnection({ cwd: process.cwd() });
			try {
				const initialize = await connection.initialize(signal);
				if (initialize.agentCapabilities?.auth?.logout) {
					await connection.logout(signal);
					server = true;
				}
			} finally {
				await connection.close();
			}
		} catch {
			// A missing or broken runtime still gets the local cleanup below.
		}
		// Never touch real credentials from an injected (test) connection.
		if (this.ensureAgent) {
			clearAntigravityCredentials();
			clearKeychainCredentials();
		}
		return { server };
	}

	async listSessions(cwd = process.cwd(), signal?: AbortSignal): Promise<SessionInfo[]> {
		this.assertActive();
		if (this.ensureAgent) await ensureAntigravityAcpReady(undefined, signal);
		const connection = this.createConnection({ cwd });
		try {
			const initialize = await connection.initialize(signal);
			if (!initialize.agentCapabilities?.sessionCapabilities?.list) {
				throw new AntigravityAcpError("protocol", "This Antigravity ACP runtime does not support session/list");
			}
			return (await connection.listSessions(cwd, signal)).sessions;
		} finally {
			await connection.close();
		}
	}

	/** Binds a Pi session to an existing Antigravity session. The next turn
	 * resumes it and sends Pi's history as reconstruction context. */
	async attachSession(piSessionId: string, acpSessionId: string, cwd = process.cwd()): Promise<void> {
		this.assertActive();
		if (!this.sessionStore) throw new AntigravityAcpError("invalid_input", "Antigravity session persistence is disabled");
		const key = `sid:${piSessionId}`;
		const binding = await this.bindings.get(key)?.catch(() => undefined);
		if (binding) {
			if (binding.turnCompletion || binding.permission || binding.pendingTools.size > 0) {
				throw new AntigravityAcpError("invalid_input", "Wait for the current Antigravity turn to finish first");
			}
			await this.dropBinding(key, binding);
		}
		this.sessionStore.save({
			piSessionId,
			acpSessionId,
			acpModelId: "",
			cwd,
			messageCount: 0,
			historyFingerprint: messagesFingerprint([]),
			lastActive: Date.now(),
		});
	}

	setPermissionMode(mode: PermissionMode): Promise<void> {
		const change = this.modeChanges.then(async () => {
			this.assertActive();
			this.permissionMode = mode;
			await Promise.all([...this.resolvedBindings].map(async (binding) => {
				if (binding.mode === mode && this.confirmedMode(binding) === mode) return;
				// Never change policy under an executing turn or leave an unsupported session alive.
				if (!binding.turnCompletion && supportsMode(binding.connection.getSessionState(binding.session.sessionId), mode)) {
					try {
						await binding.connection.setMode(binding.session.sessionId, mode);
						if (this.confirmedMode(binding) === mode) { binding.mode = mode; return; }
					} catch { /* Close below; the next turn must negotiate again. */ }
				}
				await this.invalidateBinding(binding);
			}));
		});
		this.modeChanges = change.catch(() => undefined);
		return change;
	}

	/** Takes effect on each session's next prompt, which resumes the ACP
	 * session with the new tool filter. */
	setToolOwner(owner: ToolOwner): void {
		this.toolOwner = owner;
	}

	getPermission(requestId: string): PermissionView | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission?.id === requestId) return permissionView(binding.permission);
		}
		return undefined;
	}

	async snapshot(includeStderr = false): Promise<RuntimeSnapshot> {
		const entries = [...this.bindings.entries()];
		const processes = await Promise.all(
			entries.map(async ([key, pending]) => {
				const binding = await pending;
				const pid = binding.connection.process.pid;
				return {
					key,
					...(pid === undefined ? {} : { pid }),
					generation: binding.connection.process.generation,
					sessionId: binding.session.sessionId,
					modelId: binding.modelId,
					confirmedPermissionMode: binding.mode,
					omittedTools: binding.omittedTools,
					alive: binding.connection.process.alive,
					waitingForPermission: binding.permission !== undefined,
					waitingForTools: binding.pendingTools.size,
					agentVersion: binding.initialize.agentInfo?.version,
					mcpHttp: binding.initialize.agentCapabilities?.mcpCapabilities?.http === true,
					restored: binding.restored,
					piOwnsTools: binding.piOwnsTools,
					...(binding.contextTokens === undefined ? {} : { contextTokens: binding.contextTokens }),
					ignoredStdoutNoiseLines: binding.connection.process.ignoredStdoutNoiseLines,
					...(includeStderr ? { stderrTail: binding.connection.process.stderrTail } : {}),
				};
			}),
		);
		return {
			bindings: processes.length,
			permissionMode: this.permissionMode,
			toolOwner: this.toolOwner,
			metrics: this.metrics.snapshot(),
			processes,
		};
	}

	close(): Promise<void> {
		this.disposed = true;
		return this.closePromise ??= this.closeBindings();
	}

	private async closeBindings(): Promise<void> {
		this.bindingEpoch += 1;
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) {
			cancelPermission(binding);
			cancelPiTools(binding, "Provider shut down before Pi returned the tool result");
		}
		this.resolvedBindings.clear();
		// Includes authentication/discovery and sessions still initializing, not just warm bindings.
		await Promise.allSettled([...this.activeConnections].map((connection) => connection.close()));
		await Promise.allSettled(
			pending.map(async (binding) => {
				const value = await binding;
				await Promise.allSettled([
					value.connection.close(),
					value.bridge?.close() ?? Promise.resolve(),
				]);
			}),
		);
	}

	private async runQueued(
		model: AntigravityModel,
		context: Context,
		options: SimpleStreamOptions,
		writer: PiEventWriter,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(undefined, options.signal);
		await this.modeChanges;
		this.assertEpoch(epoch);
		const persistent = Boolean(options.sessionId);
		const key = options.sessionId
			? `sid:${options.sessionId}`
			: (this.findContinuationKey(context) ?? `ephemeral:${crypto.randomUUID()}`);
		const tools = getCurrentTools(normalizeContext(context).messages);
		const acpModelId = resolveAcpModelId(model, options.reasoning);
		let binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
		await this.modeChanges;
		this.assertEpoch(epoch);
		// Check before continuation early returns as well as before fresh prompts.
		if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode ||
			binding.toolFingerprint !== piToolFingerprint(tools)) {
			await this.invalidateBinding(binding);
			binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
		}

		// Pi compacted (or otherwise rewrote) the history this session holds while
		// the prompt waited on Pi, or the harness replaced it with its own summary.
		// Resuming would keep Antigravity's version, so the turn restarts in a
		// fresh session built from Pi's context.
		const diverged = (binding.permission !== undefined || binding.pendingTools.size > 0) &&
			(binding.harnessCheckpointed || contextDiverged(binding, context));

		// A permission tool result resumes the still-running ACP prompt rather than
		// starting a second Antigravity turn.
		if (binding.permission) {
			const pending = binding.permission;
			const result = findPermissionResult(context, pending.id);
			if (!result || diverged) {
				cancelPermission(binding);
				await this.dropBinding(key, binding, diverged);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else {
				attachWriter(binding, writer);
				this.noteContinuationInstructions(binding, context);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				binding.permission = undefined;
				clearTimeout(pending.timer);
				if (
					!result.cancelled &&
					result.optionId &&
					pending.request.options.some((option) => option.optionId === result.optionId)
				) {
					pending.resolve({ outcome: { outcome: "selected", optionId: result.optionId } });
				} else {
					pending.resolve({ outcome: { outcome: "cancelled" } });
				}
				await this.awaitContinuation(binding, writer, options.signal);
				return;
			}
		}

		if (binding.pendingTools.size > 0) {
			const results = [...binding.pendingTools.values()].map((pending) => ({
				pending,
				message: findToolResult(context, pending.invocation.id, pending.invocation.name),
			}));
			if (diverged || results.some((result) => result.message === undefined)) {
				cancelPiTools(binding, diverged
					? "Antigravity restarts from Pi's context"
					: "Pi continued without returning every requested tool result");
				await this.dropBinding(key, binding, diverged);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else {
				attachWriter(binding, writer);
				this.noteContinuationInstructions(binding, context);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				for (const { pending, message } of results) {
					binding.pendingTools.delete(pending.invocation.id);
					const result = message as ToolResultMessage;
					if (pending.abandoned) binding.lateResults.push({ toolName: pending.invocation.name, result });
					else pending.resolve(toMcpToolResult(result));
				}
				await this.awaitContinuation(binding, writer, options.signal);
				return;
			}
		}

		const previous = this.queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const queue = new Promise<void>((resolve) => { release = resolve; });
		this.queues.set(key, queue);
		await previous;

		let completeTurn: (() => void) | undefined;
		let onTurnAbort: (() => void) | undefined;
		try {
			await this.modeChanges;
			this.assertEpoch(epoch);
			// A queued caller may hold an obsolete binding after shutdown/mode changes.
			binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			if (
				binding.needsReconstruction || binding.harnessCheckpointed || binding.mode !== this.permissionMode ||
				this.confirmedMode(binding) !== this.permissionMode ||
				binding.toolFingerprint !== piToolFingerprint(tools) ||
				context.messages.length < binding.messageCount ||
				messagesFingerprint(context.messages.slice(0, binding.messageCount)) !==
					binding.historyFingerprint
			) {
				await this.dropBinding(key, binding, true);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			}
			// A tool-owner switch keeps the ACP session; the next binding resumes it
			// with the new tool filter.
			if (binding.toolOwner !== this.toolOwner) {
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			}
			if (binding.modelId !== acpModelId) {
				await binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal, resolveAcpThinking(model, acpModelId));
				binding.modelId = acpModelId;
			}
			attachWriter(binding, writer);

			const fresh = binding.messageCount === 0;
			let unseenStart = binding.messageCount;
			const expected = context.messages[unseenStart];
			if (
				!fresh &&
				expected?.role === "assistant" &&
				binding.expectedAssistantFingerprint === messageFingerprint(expected)
			) {
				unseenStart += 1;
			}
			const parts = adaptPromptToCapabilities(
				buildPromptParts(context, fresh, unseenStart),
				binding.initialize,
			);
			await this.modeChanges;
			this.assertEpoch(epoch);
			if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode || !binding.connection.process.alive) {
				await this.invalidateBinding(binding);
				throw new AntigravityAcpError("protocol", "Permission mode changed before prompting; retry the turn");
			}
			binding.instructionsFingerprint = instructionFingerprint(context);
			binding.needsReconstruction = false;
			binding.pendingContextCount = context.messages.length;
			binding.pendingContextFingerprint = messagesFingerprint(context.messages);
			binding.turnCompletion = new Promise<void>((resolve) => {
				completeTurn = resolve;
			});
			if (options.signal) {
				const promptBinding = binding;
				onTurnAbort = () => abortTurn(promptBinding);
				options.signal.addEventListener("abort", onTurnAbort, { once: true });
				if (options.signal.aborted) onTurnAbort();
			}
			binding.toolTracker.clear();
			binding.lateResults = [];
			binding.updateQueue = Promise.resolve();
			let response = await binding.connection.prompt(
				{ sessionId: binding.session.sessionId, prompt: parts.prompt },
				options.signal,
			);
			for (;;) {
				// ACP dispatches notifications independently of the prompt response.
				// Drain ordered async observers before closing the Pi content stream.
				// Nothing below awaits, so a continuation cannot queue work unseen.
				await binding.updateQueue;
				if (response.stopReason !== "end_turn" || binding.abortRequested || binding.lateResults.length === 0) break;
				this.metrics.record(response, usageFromPrompt(response));
				response = await binding.connection.prompt(
					{
						sessionId: binding.session.sessionId,
						prompt: followUpPrompt(binding.lateResults.splice(0)),
					},
					options.signal,
				);
			}
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			const activeWriter = binding.writer ?? writer;
			if (binding.abortRequested) throw abortError();
			const reported = usageFromPrompt(response);
			activeWriter.message.usage = withContextUsage(reported, binding.contextTokens);
			this.metrics.record(response, reported);
			activeWriter.message.rawStopReason = response.stopReason;
			binding.messageCount = binding.pendingContextCount || parts.messageCount;
			binding.historyFingerprint = binding.pendingContextFingerprint;
			binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message);
			this.persistBinding(binding);
			switch (response.stopReason) {
				case "cancelled":
					throw abortError();
				case "max_tokens":
				case "max_turn_requests":
					activeWriter.done("length");
					break;
				default:
					activeWriter.done("stop");
			}
		} catch (error) {
			binding.writer?.fail(error, isAbort(error));
			if (isAbort(error) || binding.abortRequested) abortTurn(binding);
			if (!binding.connection.process.alive) await this.dropBinding(key, binding);
			throw error;
		} finally {
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			// Antigravity abandons an MCP call after 3 minutes and may end the turn.
			// A result Pi returns later then goes out as a new prompt.
			if (completeTurn) cancelPiTools(binding, "Antigravity turn ended before Pi returned the tool result");
			completeTurn?.();
			binding.turnCompletion = undefined;
			binding.lateResults = [];
			binding.abortRequested = false;
			binding.writer = undefined;
			release();
			if (this.queues.get(key) === queue) this.queues.delete(key);
			if (!persistent) await this.dropBinding(key, binding);
		}
	}

	private async awaitContinuation(binding: Binding, writer: PiEventWriter, signal?: AbortSignal): Promise<void> {
		const completion = binding.turnCompletion;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (binding.turnCompletion !== completion || binding.abortRequested) return;
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			killTimer = setTimeout(() => {
				if (binding.turnCompletion === completion) void binding.connection.close();
			}, 1_500);
		};
		try {
			if (!completion) return;
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			await completion;
		} finally {
			signal?.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
			// The turn normally finishes this writer; Pi must never wait on it forever.
			writer.fail(new AntigravityAcpError("protocol", "Antigravity turn ended without continuing from Pi's tool result"));
		}
	}

	private findContinuationKey(context: Context): string | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission && findPermissionResult(context, binding.permission.id)) return binding.key;
			if (
				binding.pendingTools.size > 0 &&
				[...binding.pendingTools.values()].every((pending) =>
					findToolResult(context, pending.invocation.id, pending.invocation.name),
				)
			) {
				return binding.key;
			}
		}
		return undefined;
	}

	private async getBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: Context["tools"],
		signal?: AbortSignal,
	): Promise<Binding> {
		this.assertActive();
		const existing = this.bindings.get(key);
		if (existing) return existing;
		const created = this.createBinding(key, model, acpModelId, apiKey, writer, tools ?? [], signal).catch((error) => {
			if (this.bindings.get(key) === created) this.bindings.delete(key);
			throw error;
		});
		this.bindings.set(key, created);
		return created;
	}

	private async createBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: NonNullable<Context["tools"]>,
		signal?: AbortSignal,
	): Promise<Binding> {
		const cwd = process.cwd();
		const toolOwner = this.toolOwner;
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		const epoch = this.bindingEpoch;
		const fileRequest = (sessionId: string): string[] => {
			if (!binding || sessionId !== binding.session.sessionId) {
				throw RequestError.invalidParams(undefined, `Unknown session ${sessionId}`);
			}
			return clientFileRoots(binding.cwd);
		};
		const connection = this.createConnection({
			cwd,
			// With native tools, Antigravity's file reads and writes still go
			// through the provider. With Pi tools they are disabled instead,
			// because the client_* fs tools are not covered by the tool filter.
			clientFs: toolOwner === "native",
			handlers: {
				onUpdate: (notification) => this.consumeUpdate(binding, notification),
				onStall: (info) => this.noteBackendStall(binding, info),
				onPermission: async (request) => {
					await binding?.updateQueue;
					return this.requestPermission(binding, request);
				},
				onReadTextFile: (request) => readClientTextFile(request, fileRequest(request.sessionId)),
				onWriteTextFile: (request) => writeClientTextFile(request, fileRequest(request.sessionId)),
			},
		});
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const omittedTools = initialize.agentCapabilities?.mcpCapabilities?.http === true
				? planToolProjection(tools)
				: tools.filter((tool) => tool.name !== PERMISSION_TOOL_NAME).map((tool) => ({ name: tool.name, reason: "Agent did not advertise MCP over HTTP" }));
			let mcpServer;
			if (tools.length > 0 && initialize.agentCapabilities?.mcpCapabilities?.http === true) {
				bridge = new PiMcpBridge({
					tools,
					...(toolOwner === "pi" ? { descriptions: PI_TOOL_DESCRIPTIONS } : {}),
					onCall: (invocation, abandoned) => this.requestPiTool(binding, invocation, abandoned),
				});
				mcpServer = await bridge.start();
			}
			const mcpServers = mcpServer ? [mcpServer] : [];
			// Pi's tools can only stand in for the built-ins when they reach
			// Antigravity over MCP. The filter is always sent, so the native list
			// also clears a filter persisted by an earlier Pi-owned binding.
			const piOwnsTools =
				toolOwner === "pi" && initialize.agentCapabilities?.mcpCapabilities?.http === true;
			const meta: SessionMeta = {
				antigravity: {
					disabledTools: piOwnsTools
						? [...PI_OWNED_NATIVE_TOOLS, ...UNUSED_NATIVE_TOOLS]
						: [...UNUSED_NATIVE_TOOLS],
					eagerMcpServers: [BRIDGE_NAME],
					mcpMaxOutputBytes: MCP_MAX_OUTPUT_BYTES,
				},
			};
			const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
			const saved = piSessionId ? this.sessionStore?.get(piSessionId) : undefined;
			let session: AcpNewSessionResponse | undefined;
			let restored = false;
			if (saved?.cwd === cwd) {
				if (initialize.agentCapabilities?.sessionCapabilities?.resume) {
					try {
						const resumed = await connection.resumeSession(saved.acpSessionId, cwd, mcpServers, signal, meta);
						session = { sessionId: saved.acpSessionId, ...resumed };
						restored = true;
					} catch {
						// Some Antigravity builds advertise the draft method before implementing it.
					}
				}
				if (!session && initialize.agentCapabilities?.loadSession === true) {
					try {
						const loaded = await connection.loadSession(saved.acpSessionId, cwd, mcpServers, signal, meta);
						session = { sessionId: saved.acpSessionId, ...loaded };
						restored = true;
					} catch {
						this.sessionStore?.remove(saved.piSessionId);
					}
				}
			}
			session ??= await connection.newSession(cwd, signal, mcpServers, meta);
			this.assertEpoch(epoch);
			const mode = this.permissionMode;
			if (!supportsMode(session, mode)) {
				if (piSessionId) this.sessionStore?.remove(piSessionId);
				throw new AntigravityAcpError("protocol", `Antigravity ${restored ? "restored" : "new"} session did not advertise permission mode '${mode}'; refusing to prompt`);
			}
			if (sessionModes(session)?.currentModeId !== mode) await connection.setMode(session.sessionId, mode, signal);
			if (sessionModes(connection.getSessionState(session.sessionId))?.currentModeId !== mode) {
				throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested permission mode");
			}
			const currentModel = sessionModels(session)?.currentModelId;
			if (currentModel !== acpModelId) await connection.setModel(session.sessionId, acpModelId, signal, resolveAcpThinking(model, acpModelId));
			this.assertEpoch(epoch);
			if (mode !== this.permissionMode) throw new AntigravityAcpError("protocol", "Permission mode changed during session setup; retry the turn");
			const createdBinding: Binding = {
				key,
				cwd,
				connection,
				initialize,
				session,
				mode,
				instructionsFingerprint: undefined,
				needsReconstruction: false,
				modelId: acpModelId,
				messageCount: restored && saved ? saved.messageCount : 0,
				historyFingerprint: restored && saved ? saved.historyFingerprint : messagesFingerprint([]),
				expectedAssistantFingerprint: restored ? saved?.expectedAssistantFingerprint : undefined,
				pendingContextCount: 0,
				pendingContextFingerprint: messagesFingerprint([]),
				writer,
				permission: undefined,
				pendingTools: new Map(),
				lateResults: [],
				toolBatchTimer: undefined,
				bridge,
				toolFingerprint: piToolFingerprint(tools),
				omittedTools,
				toolTracker: new AcpToolTracker(),
				updateQueue: Promise.resolve(),
				turnCompletion: undefined,
				abortRequested: false,
				piSessionId,
				restored,
				toolOwner,
				piOwnsTools,
				contextTokens: undefined,
				harnessCheckpoints: undefined,
				harnessCheckpointed: false,
			};
			binding = createdBinding;
			this.persistBinding(createdBinding);
			this.resolvedBindings.add(createdBinding);
			void connection.process.exited.then(() => {
				cancelPermission(createdBinding);
				cancelPiTools(createdBinding, "Antigravity process exited before Pi returned the tool result");
				this.resolvedBindings.delete(createdBinding);
				void bridge?.close().catch(() => undefined);
				const current = this.bindings.get(key);
				if (current) void current.then((value) => {
					if (value === createdBinding && this.bindings.get(key) === current) this.bindings.delete(key);
				}).catch(() => undefined);
			}).catch(() => undefined);
			return createdBinding;
		} catch (error) {
			await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);
			throw error;
		}
	}

	private persistBinding(binding: Binding): void {
		if (!binding.piSessionId) return;
		if (binding.needsReconstruction) { this.sessionStore?.remove(binding.piSessionId); return; }
		this.sessionStore?.save({
			piSessionId: binding.piSessionId,
			acpSessionId: binding.session.sessionId,
			acpModelId: binding.modelId,
			cwd: binding.cwd,
			messageCount: binding.messageCount,
			historyFingerprint: binding.historyFingerprint,
			...(binding.expectedAssistantFingerprint
				? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint }
				: {}),
			lastActive: Date.now(),
		});
	}

	private requestPiTool(
		binding: Binding | undefined,
		invocation: PiToolInvocation,
		abandoned: AbortSignal,
	): Promise<CallToolResult> {
		if (!binding?.writer || binding.writer.finished || binding.permission || binding.abortRequested || abandoned.aborted) {
			return Promise.resolve({
				content: [{ type: "text", text: "Pi cannot accept this tool call in the current turn" }],
				isError: true,
			});
		}
		return new Promise<CallToolResult>((resolve) => {
			let release: (() => void) | undefined;
			try {
				release = binding.connection.holdPromptWatchdog(binding.session.sessionId);
				const held = release;
				const handoff = setTimeout(() => abandon(handoffResult()), this.toolHandoffMs);
				handoff.unref();
				const pending: PendingPiTool = {
					invocation,
					resolve: (result) => { clearTimeout(handoff); held(); resolve(result); },
					abandoned: false,
				};
				// Pi still runs the tool; its result reaches Antigravity as a prompt.
				const abandon = (result: CallToolResult) => {
					if (pending.abandoned || binding.pendingTools.get(invocation.id) !== pending) return;
					pending.abandoned = true;
					pending.resolve(result);
				};
				binding.pendingTools.set(invocation.id, pending);
				abandoned.addEventListener("abort", () => {
					abandon({ content: [{ type: "text", text: "Antigravity abandoned this call" }], isError: true });
				}, { once: true });
				binding.writer?.toolCall(invocation.id, invocation.name, invocation.arguments);
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				binding.toolBatchTimer = setTimeout(() => {
					binding.toolBatchTimer = undefined;
					// The step's usage update may still be resolving its real count.
					void binding.updateQueue.then(() => binding.writer?.done("toolUse"));
				}, TOOL_BATCH_MS);
				binding.toolBatchTimer.unref();
			} catch {
				binding.pendingTools.delete(invocation.id);
				release?.();
				resolve({ content: [{ type: "text", text: "Pi could not accept the tool call" }], isError: true });
			}
		});
	}

	private requestPermission(
		binding: Binding | undefined,
		request: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		if (!binding?.writer || binding.writer.finished || binding.permission || binding.abortRequested || request.sessionId !== binding.session.sessionId) {
			return Promise.resolve({ outcome: { outcome: "cancelled" } });
		}
		// Pi runs bridged tools under its own policy; an Antigravity prompt
		// would ask twice for one call.
		const allowOnce = request.options.find((option) => option.kind === "allow_once");
		if (allowOnce && binding.bridge?.reports(request.toolCall.title, request.toolCall._meta)) {
			return Promise.resolve({ outcome: { outcome: "selected", optionId: allowOnce.optionId } });
		}
		const id = crypto.randomUUID();
		return new Promise<RequestPermissionResponse>((resolve) => {
			const timer = setTimeout(() => {
				if (binding.permission?.id !== id) return;
				binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}, PERMISSION_TIMEOUT_MS);
			timer.unref();
			binding.permission = { id, request, resolve, timer };
			try {
				binding.writer?.toolCall(id, PERMISSION_TOOL_NAME, { requestId: id });
				binding.writer?.done("toolUse");
			} catch {
				clearTimeout(timer);
				if (binding.permission?.id === id) binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}
		});
	}

	/** The harness summarised the session on its own. The byte count it leaves
	 * stays high, so Pi compacts, and the next call rebuilds from Pi's context. */
	private noteHarnessCheckpoint(binding: Binding, writer: PiEventWriter, checkpoints: number): void {
		if (binding.harnessCheckpoints === undefined || checkpoints <= binding.harnessCheckpoints) {
			binding.harnessCheckpoints ??= checkpoints;
			return;
		}
		binding.harnessCheckpoints = checkpoints;
		if (binding.harnessCheckpointed) return;
		binding.harnessCheckpointed = true;
		if (binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
		writer.text(
			"\n\n⚠️ Antigravity replaced this conversation's history with its own summary. " +
				"Pi's context replaces it in a fresh Antigravity session from the next step.\n\n",
		);
	}

	private noteBackendStall(binding: Binding | undefined, info: { busy: boolean; silentMs: number; abortInMs?: number }): void {
		const writer = binding?.writer;
		if (!writer || writer.finished) return;
		const seconds = Math.max(1, Math.round(info.silentMs / 1000));
		const work = info.busy ? " with tool/permission work still outstanding" : "";
		const abort = info.abortInMs === undefined
			? "The turn keeps waiting; Esc aborts it."
			: `It will abort itself in ${Math.max(1, Math.round(info.abortInMs / 1000))}s if there is still no response; Esc aborts it now.`;
		writer.text(
			`\n\n⚠️ No response from Antigravity for ${seconds}s${work}. The model backend is likely ` +
			`unreachable (for example repeated 502s) and silently retrying. ${abort} After it fails, retry later or switch models.\n\n`,
		);
	}

	private async consumeUpdate(binding: Binding | undefined, notification: SessionNotification): Promise<void> {
		if (!binding || notification.sessionId !== binding.session.sessionId) return;
		if ((notification.update.sessionUpdate === "config_option_update" || notification.update.sessionUpdate === "current_mode_update") &&
			this.confirmedMode(binding) !== this.permissionMode) {
			binding.writer?.fail(new AntigravityAcpError("protocol", "Antigravity changed the permission mode unexpectedly; session closed"), false);
			void this.invalidateBinding(binding).catch(() => undefined);
			return;
		}
		if (!binding.writer) return;
		const writer = binding.writer;
		binding.updateQueue = binding.updateQueue.then(async () => {
			await writer.providerEvent(notification);
			for (const activity of mapSessionUpdate(notification)) {
				if (activity.type === "text") writer.text(activity.delta);
				else if (activity.type === "thought") writer.thinking(activity.delta);
				else if (activity.type === "plan") writer.thinking(activity.text);
				else if (activity.type === "usage") {
					const used = await contextTokensInUse(notification.sessionId, activity.used);
					this.noteHarnessCheckpoint(binding, writer, transcriptCheckpoints(notification.sessionId));
					binding.contextTokens = used;
					this.metrics.recordContext(used, activity.size);
					writer.message.usage = contextUsage(used);
				} else if (activity.type === "config") {
					// The server changed the selection itself, e.g. it replaced a model
					// that is no longer offered. The connection already recorded the new
					// state; Pi's selection is re-applied on the next turn.
					const modelId = sessionModels(binding.connection.getSessionState(binding.session.sessionId))?.currentModelId;
					if (modelId) {
						binding.modelId = modelId;
						writer.message.responseModel = modelId;
					}
				} else if (activity.type === "tool") {
					const toolCall = binding.toolTracker.apply(activity.update);
					if (binding.bridge?.reports(toolCall.title, toolCall._meta)) continue;
					const toolActivity: AcpToolActivity = {
						sessionId: notification.sessionId,
						...(binding.piSessionId ? { piSessionId: binding.piSessionId } : {}),
						update: activity.update,
						toolCall,
					};
					// Native ACP tools already execute remotely. A Pi toolCall would execute
					// them again; use durable display-only entries in the extension instead.
					if (this.onToolActivity) this.onToolActivity(toolActivity);
					else writer.text(`\n${toolActivityDetails(toolActivity)}\n`);
				}
			}
		});
		await binding.updateQueue;
	}

	private async dropBinding(key: string, binding: Binding, removeSaved = false): Promise<void> {
		const current = this.bindings.get(key);
		if (current && (await current) === binding && this.bindings.get(key) === current) {
			if (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
			this.bindings.delete(key);
		}
		this.resolvedBindings.delete(binding);
		cancelPermission(binding);
		cancelPiTools(binding, "Antigravity session closed before Pi returned the tool result");
		await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
	}

	private confirmedMode(binding: Binding): string | undefined {
		return sessionModes(binding.connection.getSessionState(binding.session.sessionId))?.currentModeId;
	}

	private noteContinuationInstructions(binding: Binding, context: Context): void {
		if (binding.instructionsFingerprint !== instructionFingerprint(context)) {
			// ACP has no system-update RPC. Finish this immutable prompt, then rebuild;
			// do not persist a fingerprint claiming the new instructions reached ACP.
			binding.needsReconstruction = true;
			if (binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
		}
	}

	private async invalidateBinding(binding: Binding): Promise<void> {
		if (binding.turnCompletion) abortTurn(binding);
		await this.dropBinding(binding.key, binding, true);
	}

	private createConnection(options: AntigravityConnectionOptions): AntigravityAcpConnection {
		this.assertActive();
		const connection = this.connectionFactory(options);
		this.activeConnections.add(connection);
		void connection.process.exited.then(() => this.activeConnections.delete(connection)).catch(() => undefined);
		return connection;
	}

	private assertEpoch(epoch: number): void {
		this.assertActive();
		if (epoch !== this.bindingEpoch) throw new AntigravityAcpError("process_exit", "Antigravity session was closed during setup");
	}

	private assertActive(): void {
		if (this.disposed) throw new AntigravityAcpError("process_exit", "Antigravity ACP runtime is closed");
	}
}

async function authenticateForCredential(
	connection: AntigravityAcpConnection,
	initialize: InitializeResponse,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!apiKey || apiKey === MANAGED_AUTH_MARKER) return;
	const method = initialize.authMethods?.find((candidate) => {
		const meta = candidate._meta as Record<string, unknown> | null | undefined;
		return "api-key" in (meta ?? {}) || /api key/iu.test(candidate.name);
	});
	if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise API-key authentication");
	await connection.authenticate({ methodId: method.id, _meta: { "api-key": apiKey } }, signal);
}

function adaptPromptToCapabilities(parts: PromptParts, initialize: InitializeResponse): PromptParts {
	const capabilities = initialize.agentCapabilities?.promptCapabilities;
	const output: ContentBlock[] = [];
	for (const block of parts.prompt) {
		if (block.type === "image" && capabilities?.image !== true) {
			throw new AntigravityAcpError("invalid_input", "This Antigravity ACP runtime did not advertise image input");
		}
		if (block.type === "resource" && capabilities?.embeddedContext !== true) {
			const resource = block.resource;
			if ("text" in resource) output.push({ type: "text", text: resource.text });
			continue;
		}
		output.push(block);
	}
	return { ...parts, prompt: output };
}

function hasUsableLocalAuth(health: AntigravityAuthHealth): boolean {
	return health.status === "api-key-env" || health.status === "oauth-refreshable";
}

/** A new or continuation writer starts from the session's last known context
 * fill, so Pi's context meter stays correct across tool round trips. */
function attachWriter(binding: Binding, writer: PiEventWriter): void {
	binding.writer = writer;
	writer.message.responseModel = binding.modelId;
	if (binding.contextTokens !== undefined) writer.message.usage = contextUsage(binding.contextTokens);
}

function supportsMode(session: SessionState, mode: PermissionMode): boolean {
	return sessionModes(session)?.availableModes.some((candidate) => candidate.id === mode) === true;
}

function permissionView(permission: PendingPermission): PermissionView {
	const call = permission.request.toolCall;
	const details = {
		kind: call.kind,
		locations: call.locations,
		content: call.content,
		rawInput: call.rawInput,
	};
	const visibleDetails = JSON.stringify(details, null, 2).slice(0, 8_000);
	return {
		id: permission.id,
		title: `${call.title ?? "Antigravity requests permission"}\n\n${visibleDetails}`,
		options: permission.request.options.map((option) => ({
			id: option.optionId,
			label: option.name,
			kind: option.kind,
		})),
	};
}

function findPermissionResult(context: Context, requestId: string): PermissionToolResult | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role !== "toolResult" ||
			message.toolName !== PERMISSION_TOOL_NAME ||
			message.toolCallId !== requestId
		) {
			continue;
		}
		const details = message.details as Partial<PermissionToolResult> | undefined;
		if (
			details?.kind === PERMISSION_RESULT_KIND &&
			details.requestId === requestId &&
			typeof details.cancelled === "boolean"
		) {
			return details as PermissionToolResult;
		}
		// A missing/disabled tool or malformed output is an immediate denial,
		// never an implicit approval and never a hung ACP request.
		return {
			kind: PERMISSION_RESULT_KIND,
			requestId,
			cancelled: true,
		};
	}
	return undefined;
}

/** True when `context` no longer extends what this binding's prompt was sent.
 * Changed instructions also rewrite the collapsed prefix; those finish the
 * prompt and rebuild afterwards (see noteContinuationInstructions). */
function contextDiverged(binding: Binding, context: Context): boolean {
	if (binding.instructionsFingerprint !== instructionFingerprint(context)) return false;
	return context.messages.length < binding.pendingContextCount ||
		messagesFingerprint(context.messages.slice(0, binding.pendingContextCount)) !== binding.pendingContextFingerprint;
}

function messagesFingerprint(messages: Context["messages"]): string {
	const fingerprints = messages.map(messageFingerprint);
	return createHash("sha256").update(fingerprints.join("\n")).digest("hex");
}

function messageFingerprint(message: Context["messages"][number]): string {
	let value: unknown;
	if (message.role === "user") {
		value = { role: message.role, content: message.content };
	} else if (message.role === "assistant") {
		value = {
			role: message.role,
			provider: message.provider,
			model: message.model,
			content: message.content,
		};
	} else if (message.role === "system") {
		value = {
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded,
			toolsRemoved: message.toolsRemoved,
		};
	} else {
		value = {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	}
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function findToolResult(
	context: Context,
	toolCallId: string,
	toolName: string,
): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role === "toolResult" &&
			message.toolCallId === toolCallId &&
			message.toolName === toolName
		) {
			return message;
		}
	}
	return undefined;
}

function toMcpToolResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map((block) =>
			block.type === "text"
				? { type: "text" as const, text: inlineToolText(block.text) }
				: { type: "image" as const, data: block.data, mimeType: block.mimeType },
		),
		isError: message.isError,
	};
}

/** Pi's read and bash page their own text. Text from any other tool over
 * MAX_TEXT_RESULT_BYTES keeps its head inline and is saved in full, where the
 * harness would otherwise cut it without saying where the rest is. */
function inlineToolText(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_RESULT_BYTES) return text;
	const lines = text.split("\n");
	let bytes = 0;
	let shown = 0;
	while (shown < lines.length) {
		const next = Buffer.byteLength(lines[shown]!, "utf8") + 1;
		if (bytes + next > MAX_TEXT_RESULT_BYTES - 1024) break;
		bytes += next;
		shown++;
	}
	const file = path.join(os.tmpdir(), `pi-antigravity-output-${crypto.randomUUID()}.txt`);
	let rest: string;
	try {
		fs.writeFileSync(file, text);
		rest = `Full output: ${file}. Read the rest with pi_read (offset=${shown + 1}).`;
	} catch {
		rest = "The rest could not be saved.";
	}
	return shown === 0
		? `[Line 1 exceeds ${MAX_TEXT_RESULT_BYTES / 1024} KiB. ${rest}]`
		: `${lines.slice(0, shown).join("\n")}\n\n[Showing lines 1-${shown} of ${lines.length} (${MAX_TEXT_RESULT_BYTES / 1024} KiB limit). ${rest}]`;
}

function handoffResult(): CallToolResult {
	return {
		content: [{
			type: "text",
			text:
				"[This call is still running in Pi. Its result will arrive as the next user message. " +
				"End your turn now with a brief text response, and without further tool calls, to receive it.]",
		}],
	};
}

/** Pi tool results that arrived after Antigravity abandoned the MCP call. */
function followUpPrompt(lateResults: LateResult[]): ContentBlock[] {
	const prompt: ContentBlock[] = lateResults.map(({ toolName, result }) => ({
		type: "text",
		text:
			`Pi finished your ${toolName} tool call after its MCP request had already returned. ` +
			`${result.isError ? "It failed with" : "Its result"}:\n` +
			result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
	}));
	prompt.push({ type: "text", text: "Continue the task using this result." });
	return prompt;
}

function cancelPermission(binding: Binding): void {
	if (!binding.permission) return;
	clearTimeout(binding.permission.timer);
	binding.permission.resolve({ outcome: { outcome: "cancelled" } });
	binding.permission = undefined;
}

function instructionFingerprint(context: Context): string {
	return createHash("sha256").update(currentSystemInstructions(context)).digest("hex");
}

function abortTurn(binding: Binding): void {
	binding.abortRequested = true;
	cancelPermission(binding);
	cancelPiTools(binding, "Pi turn was aborted before returning the tool result");
}

function cancelPiTools(binding: Binding, reason: string): void {
	if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
	binding.toolBatchTimer = undefined;
	for (const pending of binding.pendingTools.values()) {
		pending.resolve({ content: [{ type: "text", text: reason }], isError: true });
	}
	binding.pendingTools.clear();
}

async function raceAuthentication<T>(
	step: Promise<T>,
	authentication: Promise<void>,
): Promise<{ authenticated: true } | { authenticated: false; value: T }> {
	return Promise.race([
		step.then((value) => ({ authenticated: false as const, value })),
		authentication.then(() => ({ authenticated: true as const })),
	]);
}

function isAbort(error: unknown): boolean {
	return error instanceof AntigravityAcpError
		? error.code === "aborted"
		: error instanceof DOMException && error.name === "AbortError";
}
