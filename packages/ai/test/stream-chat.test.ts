/** DeepSeek 流式解析的单元测试：用假的 fetch 喂入预制 SSE 字节流。 */

import { describe, expect, it } from "vitest";
import { resolveModel } from "../src/models.ts";
import { streamChat } from "../src/stream.ts";
import type { ChatEvent, ToolSpec } from "../src/types.ts";

/** 把字符串按行包成 SSE 格式的字节流 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

/** 构造一个只回放预制 SSE 的 fetch */
function fakeFetch(lines: string[], status = 200): typeof fetch {
	return (async () => new Response(sseStream(lines), { status })) as unknown as typeof fetch;
}

/** 把若干 chunk 对象序列化成 SSE 行，并补上结束标记 */
function chunks(...payloads: unknown[]): string[] {
	const lines = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`);
	lines.push("data: [DONE]\n\n");
	return lines;
}

/** 收集一次调用的全部事件 */
async function collect(lines: string[], tools: ToolSpec[] = []): Promise<ChatEvent[]> {
	const events: ChatEvent[] = [];
	for await (const event of streamChat({
		model: resolveModel("deepseek-flash"),
		apiKey: "test-key",
		messages: [{ role: "user", content: "hi" }],
		tools,
		fetchImpl: fakeFetch(lines),
	})) {
		events.push(event);
	}
	return events;
}

describe("streamChat", () => {
	it("把正文增量拆成 text 事件并以 done 收尾", async () => {
		const events = await collect(
			chunks(
				{ choices: [{ delta: { content: "你" } }] },
				{ choices: [{ delta: { content: "好" } }] },
				{
					choices: [{ delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				},
			),
		);

		expect(events).toEqual([
			{ type: "text", delta: "你" },
			{ type: "text", delta: "好" },
			{ type: "done", reason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
		]);
	});

	it("服务端回报缓存命中时映射成 cachedTokens", async () => {
		// 缓存命中是「钱花在哪」里最要紧的一项（命中价约为未命中的十分之一），
		// 也是提示词前缀有没有保持稳定的体检指标。
		const events = await collect(
			chunks({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 900 },
			}),
		);

		expect(events.at(-1)).toEqual({
			type: "done",
			reason: "stop",
			usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020, cachedTokens: 900 },
		});
	});

	it("没回报缓存命中时是 undefined，而不是 0", async () => {
		// 0 是「回报了，一个都没命中」，undefined 是「没有这条信息」。界面据此决定要不要显示命中率：
		// 拿 0 编一个 0% 出来，会让本来稳定的提示词看起来像坏了。
		const events = await collect(
			chunks({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
			}),
		);
		const done = events.find((event) => event.type === "done");
		const usage = done?.type === "done" ? done.usage : null;
		expect(usage).not.toBeNull();
		expect(usage?.cachedTokens).toBeUndefined();
	});

	it("把 reasoning_content 映射成 reasoning 事件", async () => {
		const events = await collect(chunks({ choices: [{ delta: { reasoning_content: "思考中" } }] }));
		expect(events[0]).toEqual({ type: "reasoning", delta: "思考中" });
	});

	it("也接受 reasoning 字段名", async () => {
		const events = await collect(chunks({ choices: [{ delta: { reasoning: "推理" } }] }));
		expect(events[0]).toEqual({ type: "reasoning", delta: "推理" });
	});

	it("按 index 拼接分片的工具调用参数", async () => {
		const events = await collect(
			chunks(
				{
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"comm' } }],
							},
						},
					],
				},
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
			),
		);

		const toolCall = events.find((event) => event.type === "tool_call");
		expect(toolCall).toEqual({
			type: "tool_call",
			call: { id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
		});
	});

	it("并行工具调用按 index 排序发出", async () => {
		const events = await collect(
			chunks({
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 1, id: "b", function: { name: "write", arguments: "{}" } },
								{ index: 0, id: "a", function: { name: "read", arguments: "{}" } },
							],
						},
					},
				],
			}),
		);

		const ids = events.filter((event) => event.type === "tool_call").map((event) => event.call.id);
		expect(ids).toEqual(["a", "b"]);
	});

	it("缺少 id 时补一个稳定占位 id", async () => {
		const events = await collect(
			chunks({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "{}" } }] } }] }),
		);

		const toolCall = events.find((event) => event.type === "tool_call");
		expect(toolCall).toMatchObject({ call: { id: "call_0" } });
	});

	it("把工具定义放进请求体", async () => {
		let body: unknown;
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response(sseStream(["data: [DONE]\n\n"]));
		}) as unknown as typeof fetch;

		for await (const _event of streamChat({
			model: resolveModel("deepseek-flash"),
			apiKey: "x",
			messages: [],
			tools: [{ name: "bash", description: "执行命令", parameters: { type: "object" } }],
			fetchImpl,
		})) {
			// 只为触发请求
		}

		expect(body).toMatchObject({
			model: "deepseek-flash",
			stream: true,
			stream_options: { include_usage: true },
			tool_choice: "auto",
			tools: [{ type: "function", function: { name: "bash" } }],
		});
	});

	it("助理消息回传 reasoning_content 与 tool_calls", async () => {
		let body: { messages?: unknown[] } = {};
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response(sseStream(["data: [DONE]\n\n"]));
		}) as unknown as typeof fetch;

		for await (const _event of streamChat({
			model: resolveModel("deepseek-flash"),
			apiKey: "x",
			messages: [
				{ role: "user", content: "问题" },
				{
					role: "assistant",
					content: "",
					reasoning: "思路",
					toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
				},
				{ role: "tool", results: [{ toolCallId: "c1", content: "输出", isError: false }] },
			],
			fetchImpl,
		})) {
			// 只为触发请求
		}

		expect(body.messages).toEqual([
			{ role: "user", content: "问题" },
			{
				role: "assistant",
				content: "",
				reasoning_content: "思路",
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "输出" },
		]);
	});

	it("非 2xx 响应带出状态码与正文", async () => {
		const events: ChatEvent[] = [];
		const fetchImpl = (async () =>
			new Response("bad key", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
		for await (const event of streamChat({
			model: resolveModel("deepseek-flash"),
			apiKey: "x",
			messages: [],
			fetchImpl,
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{ type: "error", message: "HTTP 401 Unauthorized：bad key", code: "http", retryable: false, status: 401 },
		]);
	});

	it("网络异常转成 error 事件而不是抛出", async () => {
		const fetchImpl = (async () => {
			throw new Error("连接被拒绝");
		}) as unknown as typeof fetch;
		const events: ChatEvent[] = [];
		for await (const event of streamChat({
			model: resolveModel("deepseek-flash"),
			apiKey: "x",
			messages: [],
			fetchImpl,
		})) {
			events.push(event);
		}

		expect(events).toEqual([{ type: "error", message: "请求失败：连接被拒绝", code: "network", retryable: false }]);
	});

	it("忽略无法解析的行", async () => {
		const events = await collect(["data: 这不是 JSON\n\n", "data: [DONE]\n\n"]);
		expect(events).toEqual([{ type: "done", reason: "stop", usage: null }]);
	});
});
