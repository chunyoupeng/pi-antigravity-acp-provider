// Minimal version of the managed server's recorded AGENCY_TOOL_CALL protobuf.
export function nativeReadStep(options: {
	id?: string;
	input?: Record<string, unknown>;
	output?: string;
	error?: string;
	responseJson?: string;
	responseType?: string;
	status?: number;
	startedAt?: number;
	completedAt?: number;
} = {}): Buffer {
	const input = options.input ?? { AbsolutePath: "/workspace/file.ts", StartLine: 1, EndLine: 10 };
	const call = Buffer.concat([
		field(1, options.id ?? "call"), field(2, "view_file"), field(3, JSON.stringify(input)),
	]);
	const response = Buffer.concat([
		field(1, "view_file"),
		options.error !== undefined ? field(5, options.error) :
			field(2, options.responseJson ?? JSON.stringify({ result: options.output ?? "const value = 1;" })),
	]);
	return Buffer.concat([
		field(1, 103), field(4, options.status ?? 3),
		field(5, Buffer.concat([
			field(6, timestamp(options.startedAt ?? Date.parse("2026-01-01T00:00:00Z"))),
			field(8, timestamp(options.completedAt ?? Date.parse("2026-01-01T00:00:00.100Z"))),
		])),
		field(116, Buffer.concat([
			field(2, "view_file"),
			field(3, Buffer.concat([field(1, "type.googleapis.com/antigravity.localharness.ToolCall"), field(2, call)])),
			field(4, Buffer.concat([field(1, options.responseType ?? "type.googleapis.com/antigravity.localharness.ToolResponse"), field(2, response)])),
		])),
	]);
}

function timestamp(ms: number): Buffer {
	return Buffer.concat([field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1_000_000)]);
}

export function field(index: number, value: number | string | Uint8Array): Buffer {
	if (typeof value === "number") return Buffer.concat([varint(index * 8), varint(value)]);
	const data = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
	return Buffer.concat([varint(index * 8 + 2), varint(data.length), data]);
}

function varint(input: number): Buffer {
	let value = BigInt(input);
	const bytes: number[] = [];
	do {
		const byte = Number(value & 127n);
		value >>= 7n;
		bytes.push(byte | (value > 0 ? 128 : 0));
	} while (value > 0);
	return Buffer.from(bytes);
}
