import type http from "node:http";
import type https from "node:https";
import type tls from "node:tls";

export const CCPA_BASE_URL_ENV: "AGY_ACP_CCPA_BASE_URL";
export const CCPA_RELAY_ENABLED_ENV: "PI_ANTIGRAVITY_CCPA_RELAY";
export const CCPA_UPSTREAM_URL_ENV: "PI_ANTIGRAVITY_CCPA_UPSTREAM_URL";
export const CCPA_MAX_RETRIES_ENV: "PI_ANTIGRAVITY_CCPA_MAX_RETRIES";
export const CCPA_RETRY_BASE_MS_ENV: "PI_ANTIGRAVITY_CCPA_RETRY_BASE_MS";
export const CCPA_CACHE_FILE_ENV: "PI_ANTIGRAVITY_CCPA_CACHE_FILE";
export const CCPA_CACHE_TTL_MS_ENV: "PI_ANTIGRAVITY_CCPA_CACHE_TTL_MS";

export const DEFAULT_CCPA_UPSTREAM_URL: string;
export const DEFAULT_MAX_RETRIES: number;
export const DEFAULT_RETRY_BASE_MS: number;
export const DEFAULT_CCPA_CACHE_TTL_MS: number;

export interface ResolveProxyOptions {
	platform?: NodeJS.Platform;
	probeSystemProxy?: boolean;
	readSystemProxy?: () => string;
	forceRefreshSystemProxy?: boolean;
}

export function shouldStartCcpaRelay(env?: NodeJS.ProcessEnv): boolean;
export function shouldBypassProxy(hostname: string, port: string | number, env?: NodeJS.ProcessEnv): boolean;
export function parseSystemProxySettings(settings: string): URL | undefined;
export function probeMacSystemProxy(readSystemProxy?: () => string, forceRefresh?: boolean): URL | undefined;
export function resolveProxyUrl(targetUrl: URL, env?: NodeJS.ProcessEnv, options?: ResolveProxyOptions): URL | undefined;

export class ProxiedHttpsKeepAliveAgent extends https.Agent {
	readonly proxyUrl: URL;
	constructor(proxyUrl: URL, agentOptions?: https.AgentOptions);
}

export function createUpstreamAgent(
	upstreamUrl: URL,
	env?: NodeJS.ProcessEnv,
	agentOptions?: https.AgentOptions & tls.ConnectionOptions,
): http.Agent | https.Agent;

export interface CcpaRelayOptions {
	env?: NodeJS.ProcessEnv;
	upstreamUrl?: string;
	maxRetries?: number;
	baseDelayMs?: number;
	cacheTtlMs?: number;
	cacheFile?: string;
	agent?: http.Agent | https.Agent;
	tlsOptions?: https.AgentOptions & tls.ConnectionOptions;
	readSystemProxy?: () => string;
	onLog?: (message: string) => void;
}

export interface CcpaRelayHandle {
	readonly baseUrl: string;
	readonly port: number;
	readonly upstreamUrl: string;
	close(): Promise<void>;
}

export function startCcpaRelay(options?: CcpaRelayOptions): Promise<CcpaRelayHandle>;
