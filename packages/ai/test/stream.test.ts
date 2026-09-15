/**
 * 流式读取的收尾语义测试：正文完整到场才算 done，被掐断的正文必须报错或整段重发。
 *
 * 这里用自己控制的 ReadableStream 造「提前关闭」「一直不结束」两类残缺正文，
 * 不用真实的秒级定时器，测试必须毫秒级跑完。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, resolveModel } from "../src/models.ts";
import { SSE_IDLE_TIMEOUT_MS, streamChat } from "../src/stream.ts";
import type { ChatEvent } from "../src/types.ts";

/** 一个 chunk 对应的 SSE 行 */
function sseLine(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 正常收尾的整段 SSE 正文 */
function completeBody(text = "好"): string {
	return (
		sseLine({ choices: [{ delta: { content: text } }] }) +
		sseLine({
			choices: [{ delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}) +
		"data: [DONE]\n\n"
	);
}

/**
 * 一个串起来回放的流：按 steps 的时间差逐段推送，最后按结尾方式收场。
 *
 * 用微秒级定时器是因为测试里要制造「超时先于下一片字节发生」，真实秒级等待没必要。
 */
function stagedStream(
	steps: Array<{ delayMs: number; content?: string; end?: "close" | "never" }>,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const tick = (index: number): void => {
				if (index >= steps.length) {
					return;
				}
				const step = steps[index];
				setTimeout(() => {
					if (controller.desiredSize === null) {
						return;
					}
					if (step.content !== undefined) {
						controller.enqueue(encoder.encode(sseLine({ choices: [{ delta: { content: step.content } }] })));
					}
					if (step.end === "close") {
						controller.close();
						return;
					}
					if (step.end === "never") {
						// 一直不关闭：只能靠空闲看门狗把它断掉
						return;
					}
					tick(index + 1);
				}, step.delayMs);
			};
			tick(0);
		},
	});
}

/** 每次调用都按 factories 顺序取一个新的响应体 */
function sequencedFetch(factories: Array<() => ReadableStream<Uint8Array>>): {
	fetchImpl: typeof fetch;
	calls: () => number;
} {
	let calls = 0;
	const fetchImpl = (async () => {
		const factory = factories[Math.min(calls, factories.length - 1)];
		calls += 1;
		return new Response(factory(), { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls: () => calls };
}

/** 按顺序回放若干条 SSE 行，最后关闭正文 */
function linesStream(...lines: string[]): ReadableStream<Uint8Array> {
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

/** 先送出一段残缺正文，随后读流本身抛错的流 */
function throwingStream(prefix: string, error: Error): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let sent = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(encoder.encode(prefix));
				return;
			}
			controller.error(error);
		},
	});
}

/** 收集一次调用的全部事件 */
async function collect(request: Parameters<typeof streamChat>[0]): Promise<ChatEvent[]> {
	const events: ChatEvent[] = [];
	for await (const event of streamChat(request)) {
		events.push(event);
	}
	return events;
}

/** 组装一个最小请求，退避压到 1ms */
function makeRequest(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
	return {
		model: resolveModel("deepseek-flash"),
		messages: [{ role: "user" as const, content: "hi" }],
		apiKey: "sk-test",
		baseUrl: DEFAULT_BASE_URL,
		retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		fetchImpl,
		...overrides,
	};
}

/** 取唯一的错误事件，取不到就返回 null */
function errorEventOf(events: ChatEvent[]): Extract<ChatEvent, { type: "error" }> | null {
	const event = events.find((item) => item.type === "error");
	return event?.type === "error" ? event : null;
}

describe("streamChat 的完成判定", () => {
	it("什么都没产出就被截断时整段重发，第二次完整即成功", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			// 第一次一条分片都没送出就断线，第二次是完整正文
			return calls === 1
				? new Response(stagedStream([{ delayMs: 1, end: "close" }]))
				: new Response(linesStream(completeBody("重试后的正文")));
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));

		expect(calls).toBe(2);
		expect(events).toEqual([
			{ type: "text", delta: "重试后的正文" },
			{
				type: "done",
				reason: "stop",
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			},
		]);
	});

	it("已经产出正文后被截断时报一次错，绝不假装完成", async () => {
		const fetchImpl = (async () =>
			new Response(
				linesStream(sseLine({ choices: [{ delta: { content: "半句话" } }] })),
			)) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));

		expect(events[0]).toEqual({ type: "text", delta: "半句话" });
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		expect(events.some((event) => event.type === "done")).toBe(false);
		// 已经产出过正文，重发会让同一段文字出现两次，只能如实报错。
		expect(errorEventOf(events)).toEqual({
			type: "error",
			message: "响应流在完成前被中断，本轮回复不完整，请重试",
			code: "stream_truncated",
			retryable: true,
		});
	});

	it("有 finish_reason 但没有 [DONE] 仍按正常完成收尾", async () => {
		const fetchImpl = (async () =>
			new Response(
				linesStream(
					sseLine({ choices: [{ delta: { content: "你好" } }] }),
					sseLine({ choices: [{ delta: {}, finish_reason: "length" }] }),
				),
			)) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));

		expect(events).toEqual([
			{ type: "text", delta: "你好" },
			{ type: "done", reason: "length", usage: null },
		]);
	});

	it("命中 [DONE] 时理由缺省为 stop", async () => {
		const fetchImpl = (async () => new Response(linesStream("data: [DONE]\n\n"))) as unknown as typeof fetch;
		expect(await collect(makeRequest(fetchImpl))).toEqual([{ type: "done", reason: "stop", usage: null }]);
	});

	it("一条分片都没产出且重试用尽时报错，不假装完成", async () => {
		const fetchImpl = sequencedFetch([() => linesStream("data: {}\n\n")]);

		const events = await collect(
			makeRequest(fetchImpl.fetchImpl, { retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 } }),
		);

		expect(fetchImpl.calls()).toBe(1);
		expect(events).toEqual([
			{ type: "error", message: "响应流在完成前被中断，未收到任何内容", code: "stream_truncated", retryable: true },
		]);
	});

	it("服务端在流内回传错误时原样透出，不当成截断", async () => {
		const fetchImpl = (async () =>
			new Response(linesStream(sseLine({ error: { message: "上下文超长" } })))) as unknown as typeof fetch;

		expect(await collect(makeRequest(fetchImpl))).toEqual([
			{ type: "error", message: "上下文超长", code: "server_error", retryable: false },
		]);
	});

	it("重发时丢掉上一次攒下的半截工具调用参数", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			// 第一次的工具调用参数只到一半就断线，第二次才给完整的一条
			if (calls === 1) {
				return new Response(
					linesStream(
						sseLine({
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"comm' } }],
									},
								},
							],
						}),
					),
				);
			}
			return new Response(
				linesStream(
					sseLine({
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } },
									],
								},
							},
						],
					}),
					"data: [DONE]\n\n",
				),
			);
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));

		expect(calls).toBe(2);
		expect(events).toEqual([
			{ type: "tool_call", call: { id: "call_1", name: "bash", arguments: '{"command":"ls"}' } },
			{ type: "done", reason: "stop", usage: null },
		]);
	});
});

describe("streamChat 的错误分类", () => {
	it("限速耗尽重试后带出 429 状态码与 Retry-After", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return new Response("slow down", {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "retry-after": "3" },
			});
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl, { retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 2 } }));

		expect(calls).toBe(2);
		expect(events).toEqual([
			{
				type: "error",
				message: "HTTP 429 Too Many Requests：slow down",
				code: "http",
				retryable: true,
				status: 429,
				retryAfterMs: 3000,
			},
		]);
	});

	it("401 归为 http，且明确不可重试", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return new Response("bad key", { status: 401, statusText: "Unauthorized" });
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));

		// 不可重试的状态码只发一次请求
		expect(calls).toBe(1);
		expect(errorEventOf(events)).toEqual({
			type: "error",
			message: "HTTP 401 Unauthorized：bad key",
			code: "http",
			retryable: false,
			status: 401,
		});
	});

	it("连接层失败一律归为 network，值不值得重试交给 retryable", async () => {
		const plain = (async () => {
			throw new Error("连接被拒绝");
		}) as unknown as typeof fetch;
		expect(errorEventOf(await collect(makeRequest(plain, { retry: { retries: 0 } })))).toEqual({
			type: "error",
			message: "请求失败：连接被拒绝",
			code: "network",
			retryable: false,
		});

		const network = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		expect(errorEventOf(await collect(makeRequest(network, { retry: { retries: 0 } })))).toEqual({
			type: "error",
			message: "请求失败：fetch failed",
			code: "network",
			retryable: true,
		});
	});

	it("响应没有正文时归为 empty_body 且可重试", async () => {
		const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

		expect(errorEventOf(await collect(makeRequest(fetchImpl, { retry: { retries: 0 } })))).toEqual({
			type: "error",
			message: "响应没有正文，无法解析 SSE 流",
			code: "empty_body",
			retryable: true,
		});
	});

	it("读流本身抛错时归为 stream_read 且标记可重试", async () => {
		const fetchImpl = (async () =>
			new Response(
				throwingStream(sseLine({ choices: [{ delta: { content: "半" } }] }), new Error("连接重置")),
			)) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));

		expect(events).toContainEqual({ type: "text", delta: "半" });
		expect(errorEventOf(events)).toEqual({
			type: "error",
			message: "读取响应流失败：连接重置",
			code: "stream_read",
			retryable: true,
		});
	});
});

describe("streamChat 的空闲看门狗", () => {
	it("正文一直不来时按空闲超时收尾，不会永远挂住", async () => {
		const fetchImpl = (async () =>
			new Response(stagedStream([{ delayMs: 5_000, end: "never" }]))) as unknown as typeof fetch;

		const events = await collect(
			makeRequest(fetchImpl, { streamIdleTimeoutMs: 30, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 } }),
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		expect(errorEventOf(events)).toEqual({
			type: "error",
			message: "响应流空闲超过 0.03 秒，连接疑似中断",
			code: "stream_idle_timeout",
			retryable: true,
		});
	});

	it("已产出正文后被看门狗断掉时同样归为 stream_idle_timeout", async () => {
		const fetchImpl = (async () =>
			new Response(
				stagedStream([
					{ delayMs: 1, content: "半句" },
					{ delayMs: 5_000, end: "never" },
				]),
			)) as unknown as typeof fetch;

		const events = await collect(
			makeRequest(fetchImpl, { streamIdleTimeoutMs: 30, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 } }),
		);

		expect(events).toContainEqual({ type: "text", delta: "半句" });
		expect(errorEventOf(events)).toEqual({
			type: "error",
			message: "响应流空闲超过 0.03 秒，本轮回复不完整，请重试",
			code: "stream_idle_timeout",
			retryable: true,
		});
	});

	it("默认空闲阈值是 120 秒", () => {
		expect(SSE_IDLE_TIMEOUT_MS).toBe(120_000);
	});

	it("空闲超时且还没产出时重发，第二次成功", async () => {
		const fetchImpl = sequencedFetch([
			() => stagedStream([{ delayMs: 5_000, end: "never" }]),
			() => linesStream(completeBody("看门狗重试成功")),
		]);

		const events = await collect(makeRequest(fetchImpl.fetchImpl, { streamIdleTimeoutMs: 30 }));

		expect(fetchImpl.calls()).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "done",
			reason: "stop",
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		});
	});

	it("空闲超时且重试用尽时报超时错误，不误报成取消", async () => {
		const fetchImpl = (async () =>
			new Response(stagedStream([{ delayMs: 5_000, end: "never" }]))) as unknown as typeof fetch;

		const events = await collect(
			makeRequest(fetchImpl, { streamIdleTimeoutMs: 120, retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 2 } }),
		);

		expect(events).toEqual([
			{
				type: "error",
				message: "响应流空闲超过 0.12 秒，连接疑似中断",
				code: "stream_idle_timeout",
				retryable: true,
			},
		]);
	});
});

describe("streamChat 的取消", () => {
	it("中途取消仍然以「已取消」结束", async () => {
		const controller = new AbortController();
		const fetchImpl = (async () =>
			new Response(
				stagedStream([
					{ delayMs: 5, content: "开" },
					{ delayMs: 5_000, end: "never" },
				]),
			)) as unknown as typeof fetch;
		setTimeout(() => controller.abort(), 20);

		const events = await collect(makeRequest(fetchImpl, { signal: controller.signal }));

		expect(events).toContainEqual({ type: "text", delta: "开" });
		expect(events.filter((event) => event.type === "error")).toEqual([
			{ type: "error", message: "已取消", code: "cancelled", retryable: false },
		]);
	});
});
