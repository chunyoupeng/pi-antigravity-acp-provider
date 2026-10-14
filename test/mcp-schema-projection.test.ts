import type { Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { PiMcpBridge, piToolFingerprint, planToolProjection } from "../src/mcp/bridge.js";

const raw = (schema: unknown): Tool["parameters"] => schema as Tool["parameters"];
const route: Tool = {
	name: "route", description: "Choose a provider",
	parameters: Type.Object({ provider: Type.Optional(Type.Union([Type.Literal("antigravity-acp"), Type.Literal("other")])) }),
};
function tool(parameters: unknown, name = "probe"): Tool {
	return { name, description: name, parameters: raw(parameters) };
}
function projectedSchema(input: Tool): Record<string, any> {
	const [rows, omissions] = JSON.parse(piToolFingerprint([input]));
	expect(omissions).toEqual([]);
	expect(rows).toHaveLength(1);
	return rows[0][2];
}
function omitted(parameters: unknown, reason: string): void {
	const input = tool(parameters);
	const bridge = new PiMcpBridge({ tools: [input, route], onCall: async () => ({ content: [] }) });
	expect(bridge.omissions).toEqual([{ name: "probe", reason: `schema omitted (${reason})` }]);
	expect(planToolProjection([input])).toEqual(bridge.omissions);
	const [rows, omissions] = JSON.parse(bridge.fingerprint);
	expect(rows.map(([name]: [string]) => name)).toEqual(["pi_route"]);
	expect(omissions).toEqual(bridge.omissions);
}
const property = (value: unknown) => ({ type: "object", properties: { value } });
function nested(depth: number): object {
	let schema: object = { type: "string" };
	for (let level = 0; level < depth; level++) schema = property(schema);
	return schema;
}

describe("MCP schema projection", () => {
	it("preserves optional literal unions and falsy constants", () => {
		expect(projectedSchema(route)).toEqual({ type: "object", properties: { provider: { anyOf: [
			{ type: "string", const: "antigravity-acp", enum: ["antigravity-acp"] },
			{ type: "string", const: "other", enum: ["other"] },
		] } } });
		expect(projectedSchema(tool(Type.Object({ flag: Type.Literal(false), count: Type.Literal(0), nothing: Type.Null() })))).toMatchObject({
			properties: { flag: { type: "boolean", const: false, enum: [false] }, count: { type: "number", const: 0, enum: [0] }, nothing: { type: "null" } },
		});
		expect(projectedSchema(tool(property({ const: null })))).toMatchObject({ properties: { value: { const: null, enum: [null] } } });
	});

	it("preserves supported validation keywords and unconstrained properties", () => {
		const parameters = Type.Object({
			free: Type.Unknown(),
			value: Type.Optional(Type.Number({ multipleOf: 0.5, exclusiveMinimum: 0, exclusiveMaximum: 10 })),
			list: Type.Array(Type.String({ minLength: 1, pattern: "^x" }), { uniqueItems: true, minItems: 1, maxItems: 3 }),
		}, { additionalProperties: false, minProperties: 1, maxProperties: 3 });
		expect(projectedSchema(tool(parameters))).toEqual({ type: "object", required: ["free", "list"], additionalProperties: false,
			minProperties: 1, maxProperties: 3, properties: {
				free: {}, value: { type: "number", multipleOf: 0.5, exclusiveMinimum: 0, exclusiveMaximum: 10 },
				list: { type: "array", items: { type: "string", minLength: 1, pattern: "^x" }, uniqueItems: true, minItems: 1, maxItems: 3 },
			} });
	});

	it("rejects the whole tool rather than widening a nested constraint", () => {
		for (const value of [
			{ type: "string", not: { const: "" } },
			{ anyOf: [{ type: "string" }, { not: {} }] },
			{ type: "array", items: { allOf: [{ type: "object" }, { patternProperties: { "^x": {} } }] } },
			{ $ref: "#/definitions/value" },
		]) omitted(property(value), "unsupported_keyword");
	});

	it("rejects malformed values, unsafe names and non-object roots", () => {
		for (const value of [
			{ enum: [] }, { enum: ["x", {}] }, { anyOf: [] }, { multipleOf: 0 }, { multipleOf: -1 },
			{ minimum: undefined }, { minimum: Infinity }, { minItems: -1 }, { type: ["string", "invalid"] },
		]) omitted(property(value), "invalid_keyword_value");
		omitted(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), "unsafe_property_name");
		omitted({ properties: { value: { type: "string" } } }, "not_object");
		omitted({ type: "string" }, "not_object");
	});

	it("keeps typeless nested schemas typeless instead of inferring contradictory types", () => {
		const value = { const: 5, items: { type: "string" } };
		expect(projectedSchema(tool(property(value))).properties.value).toEqual({ const: 5, enum: [5], items: { type: "string" } });
	});

	it("supports ordinary TypeBox modifiers but rejects hidden validators", () => {
		expect(projectedSchema(tool(Type.Object({ value: Type.Readonly(Type.Optional(Type.String())) })))).toEqual({ type: "object", properties: { value: { type: "string" } } });
		omitted(Type.Object({ value: Type.Refine(Type.String(), (text) => text.length > 2) }), "unsupported_keyword");
		const hidden = { type: "string" };
		Object.defineProperty(hidden, "~validator", { value: () => false });
		omitted(property(hidden), "unsupported_keyword");
		omitted(property({ "~kind": "Custom", type: "string" }), "unsupported_keyword");
	});

	it("rejects symbols, custom prototypes, accessors and proxies without invoking them", () => {
		let invoked = 0;
		const accessor = {};
		Object.defineProperty(accessor, "type", { enumerable: true, get() { invoked++; throw new Error("no"); } });
		const proxy = new Proxy({ type: "string" }, { ownKeys() { invoked++; throw new Error("no"); } });
		const revoked = Proxy.revocable({}, {}); revoked.revoke();
		class Custom { type = "string"; }
		for (const value of [accessor, proxy, revoked.proxy, new Custom(), { type: "string", [Symbol("validator")]: true }]) {
			omitted(property(value), "unsupported_keyword");
		}
		expect(invoked).toBe(0);
	});

	it("does not invoke array iterators, getters or proxy traps", () => {
		let invoked = 0;
		const customIterator = ["x"];
		Object.defineProperty(customIterator, Symbol.iterator, { value: function* () { invoked++; yield "x"; } });
		const accessor = ["x"];
		Object.defineProperty(accessor, 0, { get() { invoked++; return "x"; } });
		const proxy = new Proxy(["x"], { get() { invoked++; return 1e9; } });
		class List extends Array<string> {}
		for (const value of [customIterator, accessor, proxy, List.from(["x"])]) omitted(property({ enum: value }), "unsupported_keyword");
		const holey = ["x"]; holey[2] = "y";
		omitted(property({ enum: holey }), "invalid_keyword_value");
		expect(invoked).toBe(0);
	});

	it("drops non-scalar defaults without walking cyclic or deeply nested metadata", () => {
		const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
		let deep: unknown = "leaf";
		for (let i = 0; i < 100_000; i++) deep = [deep];
		const parameters = { type: "object", description: undefined, examples: cyclic, properties: {
			a: { type: "object", default: cyclic }, b: { type: "array", default: deep },
			c: { type: "boolean", default: false }, d: { type: "string", title: undefined, default: "fast" },
		} };
		expect(projectedSchema(tool(parameters))).toEqual({ type: "object", properties: {
			a: { type: "object" }, b: { type: "array" }, c: { type: "boolean", default: false }, d: { type: "string", default: "fast" },
		} });
	});

	it("detects cycles while permitting ordinary shared subschemas", () => {
		const cyclic: Record<string, unknown> = { type: "object" }; cyclic.properties = { a: cyclic, b: cyclic };
		omitted(cyclic, "cyclic_schema");
		const shared = { type: "string", minLength: 1 };
		expect(projectedSchema(tool({ type: "object", properties: { a: shared, b: shared } })).properties).toEqual({ a: shared, b: shared });
	});

	it("bounds depth, output size and total work before expanding shared fan-out", () => {
		expect(projectedSchema(tool(nested(16))).type).toBe("object");
		omitted(nested(17), "too_deep");
		omitted(property({ type: "string", description: "x".repeat(70_000) }), "too_large");
		omitted(property({ type: "string", description: "π".repeat(40_000) }), "too_large");
		omitted(property({ type: "string", description: "\u0000".repeat(20_000) }), "too_large");
		let dag: object = { type: "string" };
		for (let i = 0; i < 16; i++) dag = { type: "object", properties: { a: dag, b: dag, c: dag, d: dag } };
		const visits = vi.spyOn(Object, "getOwnPropertyNames");
		try {
			omitted(dag, "too_large");
			expect(visits.mock.calls.length).toBeLessThan(100_000);
		} finally { visits.mockRestore(); }
		omitted(property({ enum: new Array(2 ** 32 - 1) }), "too_large");
	});

	it("advertises exact choices over MCP and retains original call-time validation", async () => {
		const onCall = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
		const bridge = new PiMcpBridge({ tools: [route], onCall });
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge missing");
		const client = new Client({ name: "schema-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers: Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value])) },
		});
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const catalog = await client.listTools();
			expect(catalog.tools[0]?.inputSchema.properties?.provider).toMatchObject({ anyOf: [{ const: "antigravity-acp" }, { const: "other" }] });
			expect((await client.callTool({ name: "pi_route", arguments: { provider: "invalid" } })).isError).toBe(true);
			expect(onCall).not.toHaveBeenCalled();
			expect((await client.callTool({ name: "pi_route", arguments: { provider: "antigravity-acp" } })).isError).toBeFalsy();
			expect(onCall).toHaveBeenCalledOnce();
		} finally { await client.close(); await bridge.close(); }
	});
});
