import type { Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { PiMcpBridge } from "../src/mcp/bridge.js";

const tools: Tool[] = [
	{
		name: "echo",
		description: "Echo text",
		parameters: Type.Object({ text: Type.String() }),
	},
];

describe("PiMcpBridge", () => {
	it("authenticates, lists namespaced tools, and revalidates arguments", async () => {
		const onCall = vi.fn(async ({ arguments: args }) => ({
			content: [{ type: "text" as const, text: String(args.text) }],
		}));
		const bridge = new PiMcpBridge({ tools, onCall });
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const headers = Object.fromEntries(descriptor.headers.map((header) => [header.name, header.value]));
		const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers },
		});
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const catalog = await client.listTools();
			expect(catalog.tools.map((tool) => tool.name)).toEqual(["pi_echo"]);
			const invalid = await client.callTool({ name: "pi_echo", arguments: { text: 7 } });
			expect(invalid.isError).toBe(true);
			expect(onCall).not.toHaveBeenCalled();
			const valid = await client.callTool({ name: "pi_echo", arguments: { text: "hello" } });
			expect(valid.content).toEqual([{ type: "text", text: "hello" }]);
			expect(onCall).toHaveBeenCalledOnce();
			const validBare = await client.callTool({ name: "echo", arguments: { text: "world" } });
			expect(validBare.content).toEqual([{ type: "text", text: "world" }]);
			expect(onCall).toHaveBeenCalledTimes(2);
			const unauthorized = await fetch(descriptor.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(unauthorized.status).toBe(401);
		} finally {
			await client.close();
			await bridge.close();
		}
	});

	it("recognizes Antigravity activity rows and permission prompts for its own bridged calls", () => {
		const bridge = new PiMcpBridge({ tools, onCall: vi.fn() });
		expect(bridge.reports("Running pi_echo", undefined)).toBe(true);
		expect(bridge.reports("Run pi_echo?", undefined)).toBe(true);
		expect(bridge.reports("Running pi-bridge_pi_echo", undefined)).toBe(true);
		expect(bridge.reports("Run mcp_pi-bridge_pi_echo?", undefined)).toBe(true);
		expect(bridge.reports("pi-bridge_pi_echo", undefined)).toBe(true);
		expect(bridge.reports(undefined, { mcp: { server: "pi-bridge", tool: "pi_echo" } })).toBe(true);
		expect(bridge.reports("Running pi_other", undefined)).toBe(false);
		expect(bridge.reports("Run search_web?", undefined)).toBe(false);
		expect(bridge.reports("Running run_command", undefined)).toBe(false);
	});
});
