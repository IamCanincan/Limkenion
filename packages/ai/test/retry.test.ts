/** 请求重试的单元测试：用假的 fetch 模拟网关抖动，退避时间调到毫秒级。 */

import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, resolveModel } from "../src/models.ts";
import {
	isRetryableError,
	isRetryableStatus,
	parseRetryAfter,
	RETRY_AFTER_MAX_MS,
	retryDelayMs,
	sleep,
} from "../src/retry.ts";
import { streamChat } from "../src/stream.ts";
import type { ChatEvent } from "../src/types.ts";

/** 组装一个最小的请求；退避基准压到 1ms，测试才跑得快 */
function makeRequest(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
	return {
		model: resolveModel("deepseek-flash"),
		messages: [{ role: "user" as const, content: "hi" }],
		apiKey: "sk-test",
		baseUrl: DEFAULT_BASE_URL,
		fetchImpl,
		retry: { baseDelayMs: 1, maxDelayMs: 4 },
		...overrides,
	};
}

/** 收集所有事件 */
async function collect(request: Parameters<typeof streamChat>[0]): Promise<ChatEvent[]> {
	const events: ChatEvent[] = [];
	for await (const event of streamChat(request)) {
		events.push(event);
	}
	return events;
}

/** 构造一个正常的 SSE 响应 */
function okResponse(): Response {
	const body = [
		'data: {"choices":[{"delta":{"content":"好"},"index":0}]}',
		"",
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}',
		"",
		"data: [DONE]",
		"",
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 构造一个错误响应 */
function errorResponse(status: number, message = "boom", headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("重试判定", () => {
	it("只有限速与网关类状态码值得重试", () => {
		for (const status of [408, 429, 500, 502, 503, 504]) {
			expect(isRetryableStatus(status)).toBe(true);
		}
		for (const status of [400, 401, 403, 404, 422]) {
			expect(isRetryableStatus(status)).toBe(false);
		}
	});

	it("网络错误重试，主动取消不重试", () => {
		expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
		expect(isRetryableError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(isRetryableError(abort)).toBe(false);
	});

	it("Retry-After 支持秒数与日期两种写法", () => {
		expect(parseRetryAfter("2")).toBe(2000);
		expect(parseRetryAfter(null)).toBeNull();
		expect(parseRetryAfter("不是时间")).toBeNull();
		const now = Date.parse("2026-01-01T00:00:00Z");
		expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
	});

	it("退避是指数增长且不超过上限", () => {
		const options = { baseDelayMs: 100, maxDelayMs: 1000 };
		expect(retryDelayMs(0, options, null, () => 0)).toBe(100);
		expect(retryDelayMs(1, options, null, () => 0)).toBe(200);
		expect(retryDelayMs(4, options, null, () => 0)).toBe(1000);
		// 抖动最多 25%
		expect(retryDelayMs(0, options, null, () => 1)).toBe(125);
	});

	it("Retry-After 是服务端指令：不受我们自己的退避上限约束，但有硬上限兜底", () => {
		const options = { baseDelayMs: 100, maxDelayMs: 1000 };
		// 服务端说 5 秒，就等 5 秒——不是 1 秒（夹到上限会让几次重试全撞在同一个限速窗口里）
		expect(retryDelayMs(0, options, 5000, () => 0)).toBe(5000);
		// 比我们自己的退避短时按我们的来：等够再试总没错
		expect(retryDelayMs(4, options, 10, () => 0)).toBe(1000);
		// 病态的响应头（这里约 11 天）由硬上限兜住，不让一整轮生成挂死
		expect(retryDelayMs(0, options, 999_999_999, () => 0)).toBe(RETRY_AFTER_MAX_MS);
	});

	it("sleep 可被取消", async () => {
		const controller = new AbortController();
		const pending = sleep(5000, controller.signal);
		controller.abort();
		expect(await pending).toBe(false);
		expect(await sleep(1)).toBe(true);
	});
});

describe("streamChat 的重试", () => {
	it("503 之后成功，事件流正常结束", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return calls === 1 ? errorResponse(503) : okResponse();
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));
		expect(calls).toBe(2);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.some((event) => event.type === "done")).toBe(true);
	});

	it("网络错误之后成功", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) {
				throw new TypeError("fetch failed");
			}
			return okResponse();
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));
		expect(calls).toBe(2);
		expect(events.some((event) => event.type === "done")).toBe(true);
	});

	it("401 不重试，直接报错", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return errorResponse(401, "invalid key");
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));
		expect(calls).toBe(1);
		const error = events.find((event) => event.type === "error");
		expect(error && "message" in error ? error.message : "").toContain("HTTP 401");
	});

	it("重试次数用尽后带着最后一次的状态码报错", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return errorResponse(429, "rate limited");
		}) as unknown as typeof fetch;

		const events = await collect(makeRequest(fetchImpl));
		// 默认重试 2 次 => 一共 3 次请求
		expect(calls).toBe(3);
		const error = events.find((event) => event.type === "error");
		expect(error && "message" in error ? error.message : "").toContain("HTTP 429");
	});

	it("尊重 Retry-After，并通过 onRetry 汇报", async () => {
		let calls = 0;
		const seen: number[] = [];
		const fetchImpl = (async () => {
			calls += 1;
			return calls === 1 ? errorResponse(429, "slow down", { "retry-after": "1" }) : okResponse();
		}) as unknown as typeof fetch;

		await collect(
			makeRequest(fetchImpl, {
				onRetry: (info: { attempt: number; delayMs: number }) => seen.push(info.delayMs),
				// 上限放大，才能看出它确实听了 Retry-After
				retry: { baseDelayMs: 1, maxDelayMs: 2000 },
			}),
		);
		expect(seen.length).toBe(1);
		expect(seen[0]).toBeGreaterThanOrEqual(1000);
	});

	it("退避期间取消就停下，不再发请求", async () => {
		let calls = 0;
		const controller = new AbortController();
		const fetchImpl = (async () => {
			calls += 1;
			// 第一次就限速；退避开始后我们立刻取消
			setTimeout(() => controller.abort(), 1);
			return errorResponse(503);
		}) as unknown as typeof fetch;

		const events = await collect(
			makeRequest(fetchImpl, { signal: controller.signal, retry: { baseDelayMs: 400, maxDelayMs: 400 } }),
		);
		expect(calls).toBe(1);
		const error = events.find((event) => event.type === "error");
		expect(error && "message" in error ? error.message : "").toBe("已取消");
	});

	it("retries 设为 0 表示不重试", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return errorResponse(503);
		}) as unknown as typeof fetch;

		await collect(makeRequest(fetchImpl, { retry: { retries: 0 } }));
		expect(calls).toBe(1);
	});
});
