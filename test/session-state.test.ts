import { describe, expect, it } from "vitest";

import { decodeSessionState, sessionModels, sessionModes } from "../src/acp/session-state.js";

const modelSelector = {
	id: "model", name: "Model", type: "select", currentValue: "modern",
	options: [{ value: "modern", name: "Modern" }],
};

describe("ACP session compatibility", () => {
	it("prefers stable config options over legacy fields, including selectors without categories", () => {
		const state = decodeSessionState({
			models: { currentModelId: "legacy", availableModels: [{ modelId: "legacy", name: "Legacy" }] },
			configOptions: [modelSelector, { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] }],
		});
		expect(sessionModels(state)).toEqual({ currentModelId: "modern", availableModels: [{ modelId: "modern", name: "Modern" }] });
		expect(sessionModes(state)?.currentModeId).toBe("default");
	});

	it("retains valid legacy metadata and tolerates absent optional state", () => {
		const models = { currentModelId: "old", availableModels: [{ modelId: "old", name: "Old" }] };
		expect(sessionModels(decodeSessionState({ models }))).toEqual(models);
		expect(sessionModels(decodeSessionState({}))).toBeUndefined();
	});

	it("synthesizes effort-qualified models when model and thought_level selectors are split", () => {
		const state = decodeSessionState({
			configOptions: [
				{
					id: "model",
					name: "Model",
					category: "model",
					type: "select",
					currentValue: "gemini-3.8-flash",
					options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
				},
				{
					id: "thinking_level",
					name: "Thinking Level",
					category: "thought_level",
					type: "select",
					currentValue: "medium",
					options: [
						{ value: "low", name: "Low" },
						{ value: "medium", name: "Medium" },
						{ value: "high", name: "High" },
					],
				},
			],
		});
		expect(sessionModels(state)).toEqual({
			currentModelId: "gemini-3.8-flash-medium",
			availableModels: [
				{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
				{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			],
		});
	});

	it.each([
		null,
		{ models: { currentModelId: "bad", availableModels: [{ modelId: 123, name: "Bad" }] } },
		{ configOptions: [{ ...modelSelector, currentValue: false }] },
		{ configOptions: [{ ...modelSelector, options: [{ value: 123, name: "Bad" }] }] },
	])("rejects malformed session state without leaking server data: %j", (state) => {
		expect(() => decodeSessionState(state)).toThrow("Invalid ACP session configuration");
	});
});
