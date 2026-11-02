import {
	ClientSideConnection,
	PROTOCOL_VERSION,
	RequestError,
	type AuthenticateRequest,
	type InitializeResponse,
	type ListSessionsResponse,
	type McpServer,
	type PromptRequest,
	type PromptResponse,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type WriteTextFileRequest,
	type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import { PACKAGE_VERSION } from "../constants.js";
import { boundedNdjsonStream } from "./bounded-stream.js";
import { BackendDiagnostics, describeBackendSilence } from "./backend-diagnostics.js";
import { abortError, AntigravityAcpError, redact } from "./errors.js";
import { AntigravityProcess, type AntigravityProcessOptions } from "./process.js";
import { PromptWatchdog } from "./prompt-watchdog.js";
import {
	decodeSessionState,
	findSessionSelector,
	selectorValues,
	splitSessionModelId,
	type AcpNewSessionResponse,
	type SessionSelectorCategory,
	type SessionState,
} from "./session-state.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

export interface PromptStallInfo {
	busy: boolean;
	silentMs: number;
	abortInMs?: number;
	upstreamError?: string;
	/** Set while the relay still receives the model's response: bytes received so far. */
	streamingBytes?: number;
}

export interface AntigravityConnectionHandlers {
	onUpdate?: (notification: SessionNotification) => void | Promise<void>;
	/** Fires once per silence streak while a prompt waits on a mute backend. abortInMs is set when the idle prompt will abort itself afterwards. */
	onStall?: (info: PromptStallInfo) => void;
	onPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
	onReadTextFile?: (request: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
	onWriteTextFile?: (request: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
}

export type SessionMeta = Record<string, unknown>;

export interface AntigravityConnectionOptions extends AntigravityProcessOptions {
	handlers?: AntigravityConnectionHandlers;
	/** Advertise ACP fs so Antigravity's file tools call back into the provider. */
	clientFs?: boolean;
	initializeTimeoutMs?: number;
	operationTimeoutMs?: number;
	/** No inbound progress while the model is idle (default 10 minutes). */
	promptIdleTimeoutMs?: number;
	/** No inbound progress while a tool/permission is outstanding (default 60 minutes). */
	promptWorkIdleTimeoutMs?: number;
	/** Surface a stall warning after this much silence; the hard timeout still applies (default 90 seconds). */
	promptStallWarnMs?: number;
	/** Abort an idle prompt this long after the stall warning when silence continues (default 90 seconds). */
	promptStallAbortMs?: number;
	maxFrameBytes?: number;
}

export class AntigravityAcpConnection {
	readonly process: AntigravityProcess;
	readonly initialized: Promise<InitializeResponse>;
	private readonly connection: ClientSideConnection;
	private readonly operationTimeoutMs: number;
	private readonly promptIdleTimeoutMs: number;
	private readonly promptWorkIdleTimeoutMs: number;
	private readonly promptStallWarnMs: number;
	private readonly promptStallAbortMs: number;
	private readonly watchdogs = new Map<string, PromptWatchdog>();
	private readonly protocolFailure: Promise<never>;
	private readonly processFailure: Promise<never>;
	private readonly sessions = new Map<string, SessionState>();
	private handlers: AntigravityConnectionHandlers;
	private closePromise?: Promise<void>;

	constructor(options: AntigravityConnectionOptions) {
		this.handlers = options.handlers ?? {};
		this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
		this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? 10 * 60_000;
		this.promptWorkIdleTimeoutMs = options.promptWorkIdleTimeoutMs ?? 60 * 60_000;
		this.promptStallWarnMs = options.promptStallWarnMs ?? 90_000;
		this.promptStallAbortMs = options.promptStallAbortMs ?? 90_000;
		// Validate before spawning a process, including programmatic timeout overrides.
		new PromptWatchdog(
			this.promptIdleTimeoutMs, this.promptWorkIdleTimeoutMs, () => undefined, this.promptStallWarnMs, undefined, this.promptStallAbortMs,
		).dispose();
		this.process = new AntigravityProcess(options);
		let rejectProtocolFailure!: (error: Error) => void;
		this.protocolFailure = new Promise<never>((_resolve, reject) => {
			rejectProtocolFailure = reject;
		});
		// Keep the rejection observed even if output fails while no request is
		// active. Individual operations still race against the original promise.
		void this.protocolFailure.catch(() => undefined);
		this.processFailure = this.process.exited.then(({ code, signal, stderrTail }) => {
			const status = signal ? `signal ${signal}` : `code ${String(code)}`;
			const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
			throw new AntigravityAcpError(
				"process_exit",
				`Antigravity ACP process exited with ${status}${detail}`,
			);
		});
		// Process exit is expected during close; observe it here while active
		// operations race against the original rejecting promise below.
		void this.processFailure.catch(() => undefined);
		const stream = boundedNdjsonStream(this.process.output, this.process.input, {
			...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
			onCompatibilityNoise: () => this.process.recordCompatibilityNoise(),
			onProtocolError: (error) => {
				rejectProtocolFailure(error);
				void this.process.close();
			},
			closeOnProtocolError: true,
		});
		this.connection = new ClientSideConnection(
			() => ({
				requestPermission: async (request) => {
					const release = this.watchdogs.get(request.sessionId)?.beginPermission();
					try {
						return (await this.handlers.onPermission?.(request)) ?? { outcome: { outcome: "cancelled" } };
					} finally {
						release?.();
					}
				},
				sessionUpdate: async (notification) => {
					this.watchdogs.get(notification.sessionId)?.noteUpdate(notification);
					if (notification.update.sessionUpdate === "config_option_update") {
						this.updateSessionState(notification.sessionId, notification.update);
					} else if (notification.update.sessionUpdate === "current_mode_update") {
						const state = this.getSessionState(notification.sessionId);
						if (state.modes) this.sessions.set(notification.sessionId, {
							...state, modes: { ...state.modes, currentModeId: notification.update.currentModeId },
						});
					}
					await this.handlers.onUpdate?.(notification);
				},
				readTextFile: async (request) => {
					if (!this.handlers.onReadTextFile) throw RequestError.methodNotFound("fs/read_text_file");
					return this.handlers.onReadTextFile(request);
				},
				writeTextFile: async (request) => {
					if (!this.handlers.onWriteTextFile) throw RequestError.methodNotFound("fs/write_text_file");
					return this.handlers.onWriteTextFile(request);
				},
			}),
			stream,
		);
		this.initialized = this.withDeadline(
			this.connection.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: options.clientFs === true, writeTextFile: options.clientFs === true },
					terminal: false,
				},
				clientInfo: {
					name: "pi-antigravity-acp-provider",
					title: "Pi Antigravity ACP Provider",
					version: PACKAGE_VERSION,
				},
			}),
			options.initializeTimeoutMs ?? 30_000,
			"initialize",
		);
		// Initialization can outlive a cancelled catalog refresh.
		void this.initialized.catch(() => undefined);
	}

	setHandlers(handlers: AntigravityConnectionHandlers): void {
		this.handlers = handlers;
	}

	async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
		const response = await this.withAbort(this.initialized, signal);
		if (response.protocolVersion !== PROTOCOL_VERSION) {
			await this.close();
			throw new AntigravityAcpError(
				"protocol",
				`Unsupported ACP protocol version ${String(response.protocolVersion)}`,
			);
		}
		return response;
	}

	async authenticate(
		request: AuthenticateRequest,
		signal?: AbortSignal,
		timeoutMs = 180_000,
	): Promise<void> {
		await this.initialize();
		await this.withAbort(
			this.withDeadline(this.connection.authenticate(request), timeoutMs, "authenticate"),
			signal,
		);
	}

	async newSession(
		cwd: string,
		signal?: AbortSignal,
		mcpServers: McpServer[] = [],
		meta?: SessionMeta,
		additionalDirectories?: string[],
	): Promise<AcpNewSessionResponse> {
		const init = await this.initialize();
		const supportsAdditionalDirs =
			init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== undefined &&
			init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== null;
		const response = await this.withAbort(
			this.withDeadline(
				this.connection.newSession({
					cwd,
					mcpServers,
					...(supportsAdditionalDirs && additionalDirectories?.length ? { additionalDirectories } : {}),
					...(meta ? { _meta: meta } : {}),
				}),
				this.operationTimeoutMs,
				"session/new",
			),
			signal,
		);
		if (typeof response?.sessionId !== "string" || !response.sessionId) {
			throw new AntigravityAcpError("protocol", "Invalid ACP new-session response");
		}
		const session = { ...response, ...decodeSessionState(response) };
		this.sessions.set(session.sessionId, session);
		return session;
	}

	async loadSession(
		sessionId: string,
		cwd: string,
		mcpServers: McpServer[] = [],
		signal?: AbortSignal,
		meta?: SessionMeta,
		additionalDirectories?: string[],
	): Promise<SessionState> {
		const init = await this.initialize();
		const supportsAdditionalDirs =
			init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== undefined &&
			init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== null;
		const response = await this.withAbort(
			this.withDeadline(
				this.connection.loadSession({
					sessionId,
					cwd,
					mcpServers,
					...(supportsAdditionalDirs && additionalDirectories?.length ? { additionalDirectories } : {}),
					...(meta ? { _meta: meta } : {}),
				}),
				this.operationTimeoutMs,
				"session/load",
			),
			signal,
		);
		return this.updateSessionState(sessionId, response);
	}

	async resumeSession(
		sessionId: string,
		cwd: string,
		mcpServers: McpServer[] = [],
		signal?: AbortSignal,
		meta?: SessionMeta,
		additionalDirectories?: string[],
	): Promise<SessionState> {
		const init = await this.initialize();
		const supportsAdditionalDirs =
			init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== undefined &&
			init.agentCapabilities?.sessionCapabilities?.additionalDirectories !== null;
		const response = await this.withAbort(
			this.withDeadline(
				this.connection.resumeSession({
					sessionId,
					cwd,
					mcpServers,
					...(supportsAdditionalDirs && additionalDirectories?.length ? { additionalDirectories } : {}),
					...(meta ? { _meta: meta } : {}),
				}),
				this.operationTimeoutMs,
				"session/resume",
			),
			signal,
		);
		return this.updateSessionState(sessionId, response);
	}

	/** `thinking` names the model family and level that `modelId` is a variant
	 * of. Antigravity 1.4 offers families in the model selector plus a separate
	 * thought_level selector; it accepts a variant ID but reports the family,
	 * so the family and level are set and confirmed one by one instead. */
	async setModel(
		sessionId: string,
		modelId: string,
		signal?: AbortSignal,
		thinking?: { model: string; level: string },
	): Promise<void> {
		await this.initialize(signal);
		// Match the live selectors, not a fixed suffix list: future servers may
		// advertise levels such as `off`. Exact native model IDs take precedence.
		const state = this.getSessionState(sessionId);
		const models = findSessionSelector(state, "model");
		const split = splitSessionModelId(state, modelId) ?? (
			thinking &&
			thinking.model !== modelId &&
			models &&
			selectorValues(models).some((option) => option.value === thinking.model) &&
			!selectorValues(models).some((option) => option.value === modelId)
				? { base: thinking.model, effort: thinking.level }
				: undefined
		);
		if (split) {
			const baseWasCurrent = findSessionSelector(state, "model")?.currentValue === split.base;
			const baseConfirmed = baseWasCurrent || await this.applySelector(sessionId, "model", split.base, signal);
			if (baseConfirmed) {
				// Changing the base may replace the effort selector. Require a fresh
				// confirmation when the base changed or effort differs; never report a
				// partially applied selection as success.
				const currentState = this.getSessionState(sessionId);
				const currentThought = findSessionSelector(currentState, "thought_level");
				if (!currentThought) {
					throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested thought_level selection");
				}
				const effortConfirmed =
					(baseWasCurrent && currentThought.currentValue === split.effort) ||
					await this.applySelector(sessionId, "thought_level", split.effort, signal);
				if (!effortConfirmed) {
					throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested thought_level selection");
				}
				if (findSessionSelector(this.getSessionState(sessionId), "model")?.currentValue !== split.base) {
					throw new AntigravityAcpError("protocol", "Antigravity changed the model during thought_level selection");
				}
				return;
			}
		}
		if (await this.applySelector(sessionId, "model", modelId, signal)) return;
		// Older official Antigravity builds still implement this removed draft
		// method. Preserve its classified auth/transport errors and their causes.
		await this.withAbort(
			this.withDeadline(
				this.connection.request("session/set_model", { sessionId, modelId }),
				this.operationTimeoutMs,
				"session/set_model",
			),
			signal,
		);
	}

	async setMode(sessionId: string, modeId: string, signal?: AbortSignal): Promise<void> {
		await this.initialize(signal);
		if (await this.setSelector(sessionId, "mode", modeId, signal)) return;
		await this.withAbort(
			this.withDeadline(
				this.connection.setSessionMode({ sessionId, modeId }),
				this.operationTimeoutMs,
				"session/set_mode",
			),
			signal,
		);
		const state = this.getSessionState(sessionId);
		if (state.modes) this.sessions.set(sessionId, { ...state, modes: { ...state.modes, currentModeId: modeId } });
	}

	getSessionState(sessionId: string): SessionState {
		return this.sessions.get(sessionId) ?? {};
	}

	/** A parked Pi tool gets the bounded work-inactivity window, not an absolute deadline. */
	holdPromptWatchdog(sessionId: string): () => void {
		return this.watchdogs.get(sessionId)?.hold() ?? (() => undefined);
	}

	async listSessions(cwd: string | undefined, signal?: AbortSignal): Promise<ListSessionsResponse> {
		await this.initialize();
		return this.withAbort(
			this.withDeadline(
				this.connection.listSessions(cwd === undefined ? {} : { cwd }),
				this.operationTimeoutMs,
				"session/list",
			),
			signal,
		);
	}

	async logout(signal?: AbortSignal): Promise<void> {
		await this.initialize();
		await this.withAbort(
			this.withDeadline(this.connection.logout({}), this.operationTimeoutMs, "logout"),
			signal,
		);
	}

	async prompt(request: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
		if (signal?.aborted) throw abortError();
		const pending = this.withProgressWatchdog(request);
		if (!signal) return pending;

		return new Promise<PromptResponse>((resolve, reject) => {
			let settled = false;
			let aborting = false;
			let cancelTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (cancelTimer) clearTimeout(cancelTimer);
				signal.removeEventListener("abort", onAbort);
				callback();
			};
			const onAbort = () => {
				if (aborting) return;
				aborting = true;
				void this.cancel(request.sessionId).catch(() => undefined);
				cancelTimer = setTimeout(() => {
					void this.close().finally(() => finish(() => reject(abortError())));
				}, 1_500);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			pending.then(
				(value) => {
					if (aborting) finish(() => reject(abortError()));
					else finish(() => resolve(value));
				},
				(error: unknown) => finish(() => reject(aborting ? abortError() : error)),
			);
		});
	}

	async cancel(sessionId: string): Promise<void> {
		await this.connection.cancel({ sessionId });
	}

	async close(): Promise<void> {
		this.closePromise ??= this.process.close();
		await this.closePromise;
	}

	private updateSessionState(sessionId: string, response: unknown): SessionState {
		const state = { ...this.sessions.get(sessionId), ...decodeSessionState(response) };
		this.sessions.set(sessionId, state);
		return state;
	}

	private async setSelector(
		sessionId: string,
		category: SessionSelectorCategory,
		value: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!findSessionSelector(this.getSessionState(sessionId), category)) return false;
		if (await this.applySelector(sessionId, category, value, signal)) return true;
		throw new AntigravityAcpError("protocol", `Antigravity did not confirm the requested ${category} selection`);
	}

	/** A silent mismatch permits model selection to try the legacy method.
	 * Real request failures must propagate without being treated as mismatches. */
	private async applySelector(
		sessionId: string,
		category: SessionSelectorCategory,
		value: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		const selector = findSessionSelector(this.getSessionState(sessionId), category);
		if (!selector) return false;
		const response = await this.withAbort(
			this.withDeadline(
				this.connection.setSessionConfigOption({ sessionId, configId: selector.id, value }),
				this.operationTimeoutMs,
				"session/set_config_option",
			),
			signal,
		);
		const state = this.updateSessionState(sessionId, response);
		return findSessionSelector(state, category)?.currentValue === value;
	}

	private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		// The operation has already started. Observe it before any cancellation
		// branch closes the transport, even when we will not await its result.
		void promise.catch(() => undefined);
		if (!signal) return promise;
		if (signal.aborted) {
			await this.close();
			throw abortError();
		}
		return new Promise<T>((resolve, reject) => {
			const abort = () => {
				void this.close();
				reject(abortError());
			};
			signal.addEventListener("abort", abort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", abort);
					reject(classifyError(error));
				},
			);
		});
	}

	private async withProgressWatchdog(request: PromptRequest): Promise<PromptResponse> {
		if (this.watchdogs.has(request.sessionId)) {
			throw new AntigravityAcpError("invalid_input", "An ACP prompt is already running for this session");
		}
		// Listen only during this prompt: old errors in stderrTail must not be
		// blamed for a later turn. This connection owns one runtime binding.
		const diagnostics = new BackendDiagnostics();
		const onStderr = (chunk: string) => diagnostics.write(chunk);
		this.process.child.stderr.on("data", onStderr);
		let rejectStall!: (error: Error) => void;
		const stalled = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
		const watchdog = new PromptWatchdog(this.promptIdleTimeoutMs, this.promptWorkIdleTimeoutMs, (busy, ms) => {
			rejectStall(new AntigravityAcpError("timeout",
				`Antigravity ACP session/prompt timed out: no ${busy ? "tool/permission " : ""}progress for ${ms}ms; ` +
				describeBackendSilence(diagnostics.error) + " Retry the turn later or switch models."));
			void this.close().catch(() => undefined);
		}, this.promptStallWarnMs, (busy, silentMs, abortInMs) => {
			const upstreamError = diagnostics.error;
			const streamingBytes = diagnostics.streamingBytes;
			this.handlers.onStall?.({ busy, silentMs, ...(abortInMs === undefined ? {} : { abortInMs }),
				...(upstreamError ? { upstreamError } : {}), ...(streamingBytes === undefined ? {} : { streamingBytes }) });
		}, this.promptStallAbortMs, () => diagnostics.streamingBytes !== undefined);
		this.watchdogs.set(request.sessionId, watchdog);
		watchdog.arm();
		try {
			return await Promise.race([
				this.connection.prompt(request).catch((error: unknown) => { throw classifyError(error); }),
				this.protocolFailure, this.processFailure, stalled,
			]);
		} finally {
			watchdog.dispose();
			this.process.child.stderr.off("data", onStderr);
			this.watchdogs.delete(request.sessionId);
		}
	}

	private async withDeadline<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise.catch((error: unknown) => {
					throw classifyError(error);
				}),
				this.protocolFailure,
				this.processFailure,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						void this.close();
						reject(new AntigravityAcpError("timeout", `Antigravity ACP ${phase} timed out after ${timeoutMs}ms`));
					}, timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function classifyError(error: unknown): Error {
	if (error instanceof AntigravityAcpError) return error;
	const structured =
		error instanceof RequestError
			? error
			: error &&
				  typeof error === "object" &&
				  typeof (error as { code?: unknown }).code === "number" &&
				  typeof (error as { message?: unknown }).message === "string"
				? (error as { code: number; message: string; data?: unknown })
				: undefined;
	if (structured) {
		const detail = structuredErrorDetail(structured.data);
		const message = detail ? `${structured.message}: ${detail}` : structured.message;
		if (structured.code === -32000) {
			return new AntigravityAcpError("auth", `Antigravity authentication required: ${message}`, {
				cause: error,
			});
		}
		return new AntigravityAcpError("protocol", `Antigravity ACP error ${structured.code}: ${message}`, {
			cause: error,
		});
	}
	return error instanceof Error ? error : new Error(String(error));
}

function structuredErrorDetail(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const detail = (data as { details?: unknown }).details;
	return typeof detail === "string" && detail.trim() ? redact(detail.trim()) : undefined;
}
