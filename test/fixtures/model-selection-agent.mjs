import readline from "node:readline";

// A real JSON-RPC child process: selector updates can be ignored, partially
// applied, or fail in transport, independently of provider-side cached state.
const scenario = process.argv[2] ?? "split";
let model = "gemini-a";
let effort = "high";
let mode = "default";
const legacy = scenario.startsWith("legacy");
const thoughtId = scenario === "category-only" ? "custom-thinking" :
	scenario === "thought-alias" ? "thought_level" : "thinking_level";
const values = (ids) => ids.map((value) => ({ value, name: value }));
const configOptions = () => [
	{ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
		options: [{ group: "google", name: "Google", options: values([
			"gemini-a", "gemini-b", ...(scenario === "native-id" ? ["gemini-a-low"] : []),
		]) }] },
	...(!legacy && !(scenario === "disappearing" && model === "gemini-b") ? [{
		id: thoughtId, name: "Thinking", type: "select", currentValue: effort,
		...(["thinking-alias", "thought-alias"].includes(scenario) ? {} : { category: "thought_level" }),
		options: [{ group: "levels", name: "Levels", options: values(["off", "low", "medium", "high"]) }],
	}] : []),
	{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode,
		options: values(["default", "auto_edit", "yolo"]) },
];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
for await (const line of readline.createInterface({ input: process.stdin })) {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) continue;
	if (method === "initialize") {
		reply(id, { protocolVersion: 1, agentInfo: { name: "model-selection-agent" }, authMethods: [],
			agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
	} else if (method === "session/new") {
		reply(id, { sessionId: "selection-session", configOptions: configOptions() });
	} else if (method === "session/resume" || method === "session/load") {
		reply(id, { configOptions: configOptions() });
	} else if (method === "session/set_config_option") {
		if (["selector-auth", "selector-protocol"].includes(scenario)) {
			send({ jsonrpc: "2.0", id, error: { code: scenario === "selector-auth" ? -32000 : -32602, message: "Selector update rejected" } });
			continue;
		}
		if (params.configId === "model" && ["gemini-a", "gemini-b", ...(scenario === "native-id" ? ["gemini-a-low"] : [])].includes(params.value)) {
			if (scenario !== "ignored-base") model = params.value;
		} else if (params.configId === thoughtId) {
			if (!(scenario === "reject-low" && params.value === "low")) effort = params.value;
			if (scenario === "model-drift") model = "gemini-a";
		} else if (params.configId === "mode") mode = params.value;
		reply(id, { configOptions: configOptions() });
	} else if (method === "session/set_model") {
		if (scenario === "legacy-auth") {
			send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Token expired" } });
		} else if (scenario === "legacy-timeout") {
			continue;
		} else if (scenario === "legacy-exit") {
			process.stderr.write("selection transport exited\n");
			process.exit(7);
		} else if (legacy || scenario === "ignored-base") {
			model = params.modelId;
			reply(id, {});
		} else {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Draft model method unavailable" } });
		}
	} else if (method === "session/prompt") {
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${model}/${effort}` } } } });
		reply(id, { stopReason: "end_turn" });
	} else {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
	}
}
