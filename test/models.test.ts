import { describe, expect, it } from "vitest";

import { projectModels, resolveAcpModelId } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";

describe("projectModels", () => {
	it("deduplicates and rejects unsafe ids", () => {
		const models = projectModels([
			{ modelId: "gemini-a", name: "Gemini A" },
			{ modelId: "gemini-a", name: "duplicate" },
			{ modelId: "bad\nmodel", name: "bad" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-a"]);
		expect(models[0]?.cost.input).toBe(0);
	});

	it("collapses ACP effort variants into Pi reasoning levels", () => {
		const models = projectModels([
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
			{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
			{ modelId: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
			{ modelId: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
		]);

		expect(models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"]);
		expect(models[0]?.thinkingLevelMap?.off).toBeNull();
		expect(models[0]?.thinkingLevelMap?.medium).toBe("gemini-3.8-flash-medium");
		expect(resolveAcpModelId(models[0]!, "low")).toBe("gemini-3.8-flash-low");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-3.8-flash-high");
		expect(models[1]?.thinkingLevelMap?.medium).toBeNull();
		expect(resolveAcpModelId(models[1]!, "medium")).toBe("gemini-pro-agent");
	});

	it.each(["low", "medium", "high"] as const)("retains the only advertised %s reasoning tier without inventing variants", (effort) => {
		const id = `gemini-4-argon-${effort}`;
		const models = projectModels([{ modelId: id, name: `Gemini 4 Argon (${effort})` }]);
		expect(models).toHaveLength(1);
		expect(models[0]?.id).toBe(id);
		expect(models[0]?.reasoning).toBe(true);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(models[0]?.thinkingLevelMap?.[level]).toBe(level === effort ? id : null);
			// Unsupported programmatic levels still select the advertised ID.
			expect(resolveAcpModelId(models[0]!, level === "off" ? undefined : level)).toBe(id);
		}
		expect(resolveAcpModelId(models[0]!, undefined)).toBe(id);
	});

	it("exposes additional Argon tiers only when the server advertises them", () => {
		const models = projectModels([
			{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
			{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-4-argon"]);
		expect(models[0]?.thinkingLevelMap?.low).toBeNull();
		expect(resolveAcpModelId(models[0]!, "medium")).toBe("gemini-4-argon-medium");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-4-argon-high");
	});

	it("does not infer reasoning for a model without an advertised effort", () => {
		const models = projectModels([{ modelId: "gemini-unknown", name: "Gemini Unknown" }]);
		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("registers separate Google-account and API-key login methods", async () => {
		const { provider, runtime } = createAntigravityProvider();
		try {
			expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Google");
			expect(provider.auth.apiKey?.name).toBe("Antigravity Gemini API key");
		} finally {
			await runtime.close();
		}
	});
});
