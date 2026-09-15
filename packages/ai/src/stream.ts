/**
 * DeepSeek 流式对话客户端：发请求、看住空闲、按错误分类决定重发还是收工。
 *
 * 协议与 OpenAI 的 POST /chat/completions 兼容：请求体是 JSON，响应是 SSE，
 * 每行形如 `data: {...}`，最后一行是 `data: [DONE]`。
 *
 * **线上格式的翻译不在这个文件里**，在 `wire.ts`：字段改名、消息翻译、工具调用分片的累积都是
 * 纯函数，喂一个 chunk 就能断言，不必造一个假的 Response 流。这里只管「怎么发、发失败了怎么办」。
 *
 * 设计取舍：
 * - 直接使用全局 fetch 与手写 SSE 解析，不引入任何运行时依赖。
 * - 工具调用的参数是分片到达的，这里在内部按 index 拼接，只在参数完整后才对外
 *   发出 tool_call 事件，避免每个调用方都要重写一遍拼接逻辑。
 */

import { DEFAULT_BASE_URL, type Model } from "./models.ts";
import type { RetryOptions } from "./retry.ts";
import { DEFAULT_RETRIES, isRetryableError, isRetryableStatus, parseRetryAfter, retryDelayMs, sleep } from "./retry.ts";
import type { ChatErrorCode, ChatEvent, Message, ToolSpec, Usage } from "./types.ts";
import {
	accumulateToolCalls,
	buildBody,
	joinUrl,
	type PendingCall,
	parseChunk,
	SSE_DATA_PREFIX,
	SSE_DONE,
	toUsage,
} from "./wire.ts";

/** 发起一次流式对话所需的一切 */
export interface ChatRequest {
	/** 解析后的模型 */
	model: Model;
	/** 完整对话历史，最后一条通常是新的用户消息 */
	messages: Message[];
	/** 允许模型调用的工具，空数组表示不允许调用 */
	tools?: ToolSpec[];
	/** 接口密钥 */
	apiKey: string;
	/** 接口地址，缺省使用 DEFAULT_BASE_URL */
	baseUrl?: string;
	/** 重试参数：不传则用默认值（重试 2 次，指数退避） */
	retry?: RetryOptions;
	/** 每次准备重试时回调，用于在界面上提示「正在重试」 */
	onRetry?: (info: { attempt: number; delayMs: number }) => void;
	/** 取消信号，用于中断长回复或超时 */
	signal?: AbortSignal;
	/** 流空闲超时毫秒数，缺省使用 SSE_IDLE_TIMEOUT_MS；只在测试里缩小，用来驱动看门狗 */
	streamIdleTimeoutMs?: number;
	/** 采样温度，缺省不发送 */
	temperature?: number;
	/** 单次回复的最大 token 数，缺省不发送 */
	maxTokens?: number;
	/** 覆盖 fetch 实现，仅用于测试 */
	fetchImpl?: typeof fetch;
}

/** 流空闲超时：这么久没有新字节就认为连接已经僵死，主动中断本次请求 */
export const SSE_IDLE_TIMEOUT_MS = 120_000;

/**
 * 重试前等待一段时间。
 *
 * 返回实际等待的毫秒数；被用户取消时返回 null，调用方据此结束这一轮而不是继续发请求。
 */
async function waitBeforeRetry(
	attempt: number,
	request: ChatRequest,
	retryAfterMs: number | null,
): Promise<number | null> {
	const delay = retryDelayMs(attempt, request.retry, retryAfterMs);
	request.onRetry?.({ attempt: attempt + 1, delayMs: delay });
	const slept = await sleep(delay, request.signal);
	return slept ? delay : null;
}

/**
 * 发起流式对话，按到达顺序产出事件。
 *
 * 事件序列保证以 done 或 error 结尾。调用方只需处理增量渲染，不需要自己拼接分片。
 */
export async function* streamChat(request: ChatRequest): AsyncGenerator<ChatEvent> {
	const doFetch = request.fetchImpl ?? fetch;
	const baseUrl = request.baseUrl ?? DEFAULT_BASE_URL;
	const pending = new Map<number, PendingCall>();
	// 每次尝试都要重新收集工具调用：截断后重发时不能带上一次的残留。
	let usage: Usage | null = null;
	let reason: string | undefined;

	let attempt = 0;
	const retries = request.retry?.retries ?? DEFAULT_RETRIES;
	let hasOutput = false;

	// 一个 while 同时管住「重新发请求」与「重新读流」：正文被掐断且还没产出内容时，
	// 整段重发是唯一不会让内容重复或丢失的做法。
	while (true) {
		// 重发前清掉上一次的残留：被丢弃的那一轮可能已经攒了半截工具调用参数，
		// 留着会把两次尝试的分片拼成一条错误的调用。
		pending.clear();
		let response: Response;
		try {
			response = await doFetch(joinUrl(baseUrl, "/chat/completions"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: `Bearer ${request.apiKey}`,
				},
				body: JSON.stringify(buildBody(request)),
				signal: request.signal,
			});
		} catch (error) {
			const reasonText = describeError(error);
			// 取消排在重试之前：主动取消还接着重试就变成「点了停止还在跑」。
			if (request.signal?.aborted) {
				yield errorEvent("已取消", "cancelled", false);
				return;
			}
			// 连接层失败一律记成 network：code 说的是「哪里错了」，
			// 重试有没有用交给 retryable，两者不必绑在一起。
			const retryable = isRetryableError(error);
			if (attempt < retries && retryable) {
				const waited = await waitBeforeRetry(attempt, request, null);
				if (waited === null) {
					yield errorEvent("已取消", "cancelled", false);
					return;
				}
				attempt += 1;
				continue;
			}
			yield errorEvent(`请求失败：${reasonText}`, "network", retryable);
			return;
		}

		if (!response.ok) {
			const detail = await readErrorBody(response);
			// 先解析一次 Retry-After：既要拿它决定退避多久，也要原样告诉上层。
			const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
			if (attempt < retries && isRetryableStatus(response.status)) {
				const waited = await waitBeforeRetry(attempt, request, retryAfterMs);
				if (waited === null) {
					yield errorEvent("已取消", "cancelled", false);
					return;
				}
				attempt += 1;
				continue;
			}
			yield errorEvent(
				`HTTP ${response.status} ${response.statusText}${detail}`,
				"http",
				isRetryableStatus(response.status),
				// 上游没给 Retry-After 时整个字段都不出现，别塞 undefined 让上层去判空。
				{ status: response.status, ...(retryAfterMs === null ? {} : { retryAfterMs }) },
			);
			return;
		}

		if (!response.body) {
			yield errorEvent("响应没有正文，无法解析 SSE 流", "empty_body", true);
			return;
		}

		const outcome = yield* readAttempt(response.body, request, pending);
		hasOutput = outcome.emitted;
		reason = outcome.reason ?? reason;
		usage = outcome.usage;

		if (outcome.cancelled) {
			yield errorEvent("已取消", "cancelled", false);
			return;
		}
		if (outcome.failed !== null) {
			yield errorEvent(`读取响应流失败：${outcome.failed}`, "stream_read", true);
			return;
		}
		if (outcome.serverError !== null) {
			// 服务端自己报的错，重发多少次都是同一句话。
			yield errorEvent(outcome.serverError, "server_error", false);
			return;
		}
		if (outcome.done) {
			break;
		}

		// 到这里流是「正常收尾但没读完」：要么空闲看门狗把它断了，要么正文被提前掐断。
		const stopCode: ChatErrorCode = outcome.timedOut ? "stream_idle_timeout" : "stream_truncated";
		if (hasOutput) {
			// 已经把内容交给调用方了，重发会让同一段文字出现两次，只能如实报错。
			// 措辞上不说「已丢弃」：正文可能已经边收边打给用户看了，能保证的只是「这一轮没完成」。
			yield errorEvent(
				outcome.timedOut
					? `响应流空闲超过 ${idleTimeoutMs(request) / 1000} 秒，本轮回复不完整，请重试`
					: "响应流在完成前被中断，本轮回复不完整，请重试",
				stopCode,
				true,
			);
			return;
		}
		if (attempt < retries) {
			const waited = await waitBeforeRetry(attempt, request, null);
			if (waited === null) {
				yield errorEvent("已取消", "cancelled", false);
				return;
			}
			attempt += 1;
			continue;
		}
		yield errorEvent(
			outcome.timedOut
				? `响应流空闲超过 ${idleTimeoutMs(request) / 1000} 秒，连接疑似中断`
				: "响应流在完成前被中断，未收到任何内容",
			stopCode,
			true,
		);
		return;
	}

	// 参数完整后才对外发出工具调用，按模型给出的顺序排列。
	for (const [index, call] of [...pending.entries()].sort(([a], [b]) => a - b)) {
		// 少数兼容实现不给 id，这里补一个稳定的占位值，否则工具结果无法对上号。
		yield { type: "tool_call", call: { id: call.id || `call_${index}`, name: call.name, arguments: call.args } };
	}
	yield { type: "done", reason: reason ?? "stop", usage };
}

/** 一次流式尝试的结果：解析结果与「这次能不能重发」的判定依据都在这里 */
interface AttemptOutcome {
	/** 是否看到了 [DONE] 或 finish_reason，也就是这份正文确实完整 */
	done: boolean;
	/** 本次尝试是否已经把分片增量交给调用方；已经交过就不能重发，否则内容会重复 */
	emitted: boolean;
	/** 收尾时记录的 finish_reason，从没看到过就是 undefined */
	reason: string | undefined;
	/** 本次尝试收到的 usage */
	usage: Usage | null;
	/** 是否被空闲看门狗断掉 */
	timedOut: boolean;
	/** 是否由用户取消信号断掉 */
	cancelled: boolean;
	/** 读取流本身抛错时的可读描述，没有失败就是 null */
	failed: string | null;
	/** 服务端在流内回传的错误正文，没有就是 null */
	serverError: string | null;
}

/** 本轮实际使用的空闲超时毫秒数 */
function idleTimeoutMs(request: ChatRequest): number {
	return request.streamIdleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
}

/**
 * 组装一个 error 事件。
 *
 * 所有失败分支都从这里出：分类字段是必填的，集中在一次拼装就不会出现「某条分支忘了带 code」。
 */
function errorEvent(
	message: string,
	code: ChatErrorCode,
	retryable: boolean,
	extra: { status?: number; retryAfterMs?: number } = {},
): Extract<ChatEvent, { type: "error" }> {
	return { type: "error", message, code, retryable, ...extra };
}

/** 填一份 AttemptOutcome，只写关心的字段 */
function outcome(partial: Partial<AttemptOutcome>): AttemptOutcome {
	return {
		done: false,
		emitted: false,
		reason: undefined,
		usage: null,
		timedOut: false,
		cancelled: false,
		failed: null,
		serverError: null,
		...partial,
	};
}

/**
 * 把取消信号包成可等待的 Promise：信号触发时拒绝，配合 Promise.race 让挂住的 read 立刻收手。
 *
 * 没有取消信号时给一个永不落定的 Promise，省掉调用方到处判空。
 */
function abortable(signal: AbortSignal | undefined): Promise<never> {
	if (signal === undefined) {
		return new Promise<never>(() => {});
	}
	return new Promise<never>((_resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("已取消", "AbortError"));
			return;
		}
		signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
	});
}

/**
 * 读一次 SSE 响应，把这一轮的结果汇总成 AttemptOutcome。
 *
 * 自己开一个 AbortController 当空闲看门狗：超过阈值没有新字节就中断这次读取，
 * 否则一条僵死的连接能把整轮对话永远挂住。
 */
async function* readAttempt(
	body: ReadableStream<Uint8Array>,
	request: ChatRequest,
	pending: Map<number, PendingCall>,
): AsyncGenerator<ChatEvent, AttemptOutcome, undefined> {
	const timeoutMs = idleTimeoutMs(request);
	const idle = new AbortController();
	// AbortSignal.any 返回的就是合并后的信号本身（不是包一层对象）。
	// 没有用户取消信号时补一个永不触发的，省掉后面到处判空。
	const combined = AbortSignal.any([request.signal ?? new AbortController().signal, idle.signal]);

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// 区分「从没看到 finish_reason」与「看到的是 stop」：只有前者说明流被掐断。
	let finishReason: string | undefined;
	let usage: Usage | null = null;
	let streamDone = false;
	let emitted = false;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	// 计时器只包住「等下一片字节」这段时间，每次真的读到数据都重新计时。
	const arm = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			idle.abort();
		}, timeoutMs);
	};
	arm();

	try {
		while (!streamDone) {
			// 看门狗断开时这次 read 会以 AbortError 收场；这里补一层 catch，
			// 否则被 race 抛下的那个 promise 会变成未处理的拒绝。
			const reading = reader.read().catch((error: unknown) => {
				throw error;
			});
			const { done, value } = await Promise.race([reading, abortable(combined)]);
			if (done) {
				break;
			}
			arm();
			buffer += decoder.decode(value, { stream: true });

			// SSE 以换行为界。最后一段可能不完整，留在 buffer 里等下一次读取。
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");

				if (!line.startsWith(SSE_DATA_PREFIX)) {
					continue;
				}
				const payload = line.slice(SSE_DATA_PREFIX.length).trim();
				if (payload === SSE_DONE) {
					streamDone = true;
					break;
				}
				const chunk = parseChunk(payload);
				if (chunk === null) {
					continue;
				}
				if (chunk.error?.message) {
					return outcome({ emitted, reason: finishReason, usage, serverError: chunk.error.message });
				}

				const choice = chunk.choices?.[0];
				if (choice?.finish_reason) {
					finishReason = choice.finish_reason;
				}
				if (chunk.usage) {
					usage = toUsage(chunk.usage);
				}

				const delta = choice?.delta;
				if (!delta) {
					continue;
				}
				// 不同版本分别用 reasoning_content 与 reasoning 承载思维链。
				const reasoning = delta.reasoning_content ?? delta.reasoning;
				if (reasoning) {
					emitted = true;
					yield { type: "reasoning", delta: reasoning };
				}
				if (delta.content) {
					emitted = true;
					yield { type: "text", delta: delta.content };
				}
				accumulateToolCalls(pending, delta.tool_calls);
			}
		}
	} catch (error) {
		// 看门狗断流时 read() 以 AbortError 收场，这不是解析失败，不能混进「读取响应流失败」。
		if (timedOut) {
			return outcome({ emitted, reason: finishReason, usage, timedOut: true });
		}
		if (request.signal?.aborted) {
			return outcome({ emitted, reason: finishReason, usage, cancelled: true });
		}
		return outcome({ emitted, reason: finishReason, usage, failed: describeError(error) });
	} finally {
		// 提前退出（例如调用方 break）时释放连接，否则底层 socket 会一直挂着。
		clearTimeout(timer);
		try {
			reader.releaseLock();
		} catch {
			// 还有一次 read 悬在半空时不允许释放；此时连接已被 abort 断掉，不必再管。
		}
	}

	// 正常读到流末尾：有 [DONE] 或有 finish_reason 才算完整。
	return outcome({ done: streamDone || finishReason !== undefined, emitted, reason: finishReason, usage });
}

/** 读取错误响应正文，截断后拼进错误信息 */
async function readErrorBody(response: Response): Promise<string> {
	try {
		const text = await response.text();
		const trimmed = text.trim().slice(0, 500);
		return trimmed ? `：${trimmed}` : "";
	} catch {
		return "";
	}
}

/** 把任意异常转成可读文本 */
export function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
