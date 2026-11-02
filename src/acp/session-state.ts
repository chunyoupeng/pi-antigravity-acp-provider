import type {
	NewSessionResponse,
	SessionConfigOption,
	SessionConfigSelectOption,
	SessionModeState,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

import { splitEffortSuffix } from "../models.js";
import { AntigravityAcpError } from "./errors.js";

/** Antigravity's pre-config-option model metadata remains on older ACP v1 servers. */
export interface AcpModelInfo {
	modelId: string;
	name: string;
}

export interface SessionState {
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
	models?: { currentModelId: string; availableModels: AcpModelInfo[] } | null;
}

export type AcpNewSessionResponse = NewSessionResponse & SessionState;
type SelectOption = Extract<SessionConfigOption, { type: "select" }>;
const valueSchema = z.object({ value: z.string(), name: z.string() });
const selectorBase = { id: z.string(), name: z.string(), category: z.string().nullish() };
const stateSchema = z.object({
	modes: z.object({ currentModeId: z.string(), availableModes: z.array(z.object({ id: z.string(), name: z.string() })) }).nullish(),
	configOptions: z.array(z.discriminatedUnion("type", [
		z.object({ ...selectorBase, type: z.literal("select"), currentValue: z.string(), options: z.union([
			z.array(valueSchema),
			z.array(z.object({ group: z.string(), name: z.string(), options: z.array(valueSchema) })),
		]) }),
		z.object({ ...selectorBase, type: z.literal("boolean"), currentValue: z.boolean() }),
	])).nullish(),
	models: z.object({ currentModelId: z.string(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })) }).nullish(),
});

/** SDK 1.x no longer exports response validators or draft model types. Validate
 * the state we use explicitly, preserving legacy metadata without private imports. */
export function decodeSessionState(response: unknown): SessionState {
	const parsed = stateSchema.safeParse(response);
	if (!parsed.success) throw new AntigravityAcpError("protocol", "Invalid ACP session configuration");
	// JSON responses cannot contain explicit undefined properties; Zod's optional
	// property inference is broader than the SDK's exact-optional declarations.
	return parsed.data as SessionState;
}

export type SessionSelectorCategory = "model" | "mode" | "thought_level";

export function findSessionSelector(state: SessionState, category: SessionSelectorCategory): SelectOption | undefined {
	return state.configOptions?.find((option): option is SelectOption =>
		option.type === "select" &&
		(option.category === category ||
			option.id === category ||
			(category === "thought_level" && option.id === "thinking_level")),
	);
}

export function selectorValues(option: SelectOption): SessionConfigSelectOption[] {
	return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

/** Reverse the selector cross-product used by discovery, including unknown
 * thought levels, without misinterpreting an exact native model ID. */
export function splitSessionModelId(state: SessionState, modelId: string): { base: string; effort: string } | undefined {
	const model = findSessionSelector(state, "model");
	const thought = findSessionSelector(state, "thought_level");
	if (!model || !thought) return undefined;
	const models = selectorValues(model);
	if (models.some((option) => option.value === modelId)) return undefined;
	const levels = selectorValues(thought);
	for (const base of models) {
		const level = levels.find((option) => `${base.value}-${option.value}` === modelId);
		if (level) return { base: base.value, effort: level.value };
	}
	return undefined;
}

export function sessionModels(state: SessionState): { currentModelId: string; availableModels: AcpModelInfo[] } | undefined {
	const selector = findSessionSelector(state, "model");
	if (!selector) return state.models ?? undefined;
	const thoughtSelector = findSessionSelector(state, "thought_level");
	const modelOptions = selectorValues(selector);
	if (thoughtSelector) {
		const thoughtOptions = selectorValues(thoughtSelector);
		const qualified = (id: string) => splitEffortSuffix(id) !== undefined ||
			thoughtOptions.some((option) => option.value.length > 0 && id.endsWith(`-${option.value}`));
		if (thoughtOptions.length > 0 && modelOptions.some((option) => !qualified(option.value))) {
			const currentModelId =
				qualified(selector.currentValue) || !thoughtSelector.currentValue
					? selector.currentValue
					: `${selector.currentValue}-${thoughtSelector.currentValue}`;
			// Live selectors are authoritative; retain legacy labels only for the
			// same complete, duplicate-free inventory.
			const synthesized = modelOptions.flatMap((modelOpt) =>
				qualified(modelOpt.value)
					? [{ modelId: modelOpt.value, name: modelOpt.name }]
					: thoughtOptions.map((thoughtOpt) => ({
							modelId: `${modelOpt.value}-${thoughtOpt.value}`,
							name: `${modelOpt.name} (${thoughtOpt.name})`,
						})),
			);
			const synthesizedIds = new Set(synthesized.map((m) => m.modelId));

			const legacy = state.models?.availableModels;
			const isLegacyCompatible =
				legacy !== undefined &&
				legacy.length === synthesizedIds.size &&
				new Set(legacy.map((model) => model.modelId)).size === synthesizedIds.size &&
				legacy.every((m) => synthesizedIds.has(m.modelId));

			return {
				currentModelId,
				availableModels: isLegacyCompatible ? legacy : synthesized,
			};
		}
	}
	return {
		currentModelId: selector.currentValue,
		availableModels: modelOptions.map((option) => ({ modelId: option.value, name: option.name })),
	};
}

export function sessionModes(state: SessionState): SessionModeState | null | undefined {
	const selector = findSessionSelector(state, "mode");
	if (!selector) return state.modes;
	return {
		currentModeId: selector.currentValue,
		availableModes: selectorValues(selector).map((option) => ({ id: option.value, name: option.name })),
	};
}

