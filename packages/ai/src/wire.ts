/**
 * 线上协议：DeepSeek / OpenAI 兼容的 `/chat/completions` 线上格式。
 *
 * 与 `stream.ts` 的分工是「翻译」与「驱动」：这里只做**纯翻译**（内部消息 ↔ 线上 JSON、
 * 增量分片的累积、usage 的字段改名），不碰 fetch、不碰计时器、不碰重试。那边的
 * `streamChat()` 负责发请求、看住空闲、按错误分类决定重发还是收工。
 *
 * 拆开的理由是可测性与可读性：协议翻译是纯函数，喂一个 chunk 就能断言，不必造一个假的
 * Response 流；而「一次尝试失败了要不要重发」那套判断混在同一份文件里时，两者互相淹没——
 * 前者关心字段名，后者关心退避与取消。
 *
 * 其余 provider 特有的字段都只出现在这个文件里：上层拿到的一律是 `types.ts` 的内部类型。
 */

import type { Message, ToolSpec, Usage } from "./types.ts";

/** SSE 一行的前缀 */
export const SSE_DATA_PREFIX = "data:";

/** SSE 流结束标记 */
export const SSE_DONE = "[DONE]";

/** 工具调用增量分片的累积状态 */
export interface PendingCall {
	id: string;
	name: string;
	args: string;
}

/** 线上的增量对象，字段全部可选 */
interface WireDelta {
	content?: string | null;
	reasoning_content?: string | null;
	reasoning?: string | null;
	tool_calls?: WireToolCallDelta[] | null;
}

/** 线上的工具调用分片 */
interface WireToolCallDelta {
	index?: number | null;
	id?: string | null;
	function?: { name?: string | null; arguments?: string | null } | null;
}

/** 线上的一个 chunk */
export interface WireChunk {
	choices?: Array<{ delta?: WireDelta | null; finish_reason?: string | null }> | null;
	usage?: {
		prompt_tokens?: number | null;
		completion_tokens?: number | null;
		total_tokens?: number | null;
		/** 命中上下文缓存的部分，DeepSeek 用它区分计费 */
		prompt_cache_hit_tokens?: number | null;
	} | null;
	error?: { message?: string | null } | null;
}

/** 构造请求体所需的最小输入；`stream.ts` 的 `ChatRequest` 满足它 */
export interface WireRequest {
	model: { id: string };
	messages: Message[];
	tools?: ToolSpec[];
	temperature?: number;
	maxTokens?: number;
}

/**
 * 把内部消息翻译成线上格式。
 *
 * 注意助理消息要带回 reasoning_content：DeepSeek 在带工具调用的多轮对话里要求
 * 上一轮的思维链原样回传，缺了会被拒。
 */
export function toWireMessages(messages: Message[]): unknown[] {
	const wire: unknown[] = [];
	for (const message of messages) {
		if (message.role === "tool") {
			// 一条工具消息可能带多个结果，线上格式要求每个结果一条消息。
			for (const result of message.results) {
				wire.push({
					role: "tool",
					tool_call_id: result.toolCallId,
					content: result.content,
				});
			}
			continue;
		}
		if (message.role === "assistant") {
			wire.push({
				role: "assistant",
				content: message.content,
				reasoning_content: message.reasoning,
				tool_calls:
					message.toolCalls.length === 0
						? undefined
						: message.toolCalls.map((call) => ({
								id: call.id,
								type: "function",
								function: { name: call.name, arguments: call.arguments },
							})),
			});
			continue;
		}
		wire.push({ role: message.role, content: message.content });
	}
	return wire;
}

/** 构造请求体 */
export function buildBody(request: WireRequest): Record<string, unknown> {
	const tools = request.tools ?? [];
	const body: Record<string, unknown> = {
		model: request.model.id,
		messages: toWireMessages(request.messages),
		stream: true,
		// 让最后一帧带上 usage，否则流式模式下拿不到 token 统计。
		stream_options: { include_usage: true },
	};
	if (tools.length > 0) {
		body.tools = tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
		body.tool_choice = "auto";
	}
	if (request.temperature !== undefined) {
		body.temperature = request.temperature;
	}
	if (request.maxTokens !== undefined) {
		body.max_tokens = request.maxTokens;
	}
	return body;
}

/** 从线上 usage 转成内部类型 */
export function toUsage(raw: WireChunk["usage"]): Usage | null {
	if (!raw) {
		return null;
	}
	return {
		promptTokens: raw.prompt_tokens ?? 0,
		completionTokens: raw.completion_tokens ?? 0,
		totalTokens: raw.total_tokens ?? 0,
		cachedTokens: raw.prompt_cache_hit_tokens ?? undefined,
	};
}

/** 把分片累加到 pending 表里 */
export function accumulateToolCalls(
	pending: Map<number, PendingCall>,
	deltas: WireToolCallDelta[] | null | undefined,
): void {
	if (!deltas) {
		return;
	}
	for (const delta of deltas) {
		const index = delta.index ?? 0;
		let call = pending.get(index);
		if (!call) {
			call = { id: "", name: "", args: "" };
			pending.set(index, call);
		}
		if (delta.id) {
			call.id = delta.id;
		}
		if (delta.function?.name) {
			call.name = delta.function.name;
		}
		if (delta.function?.arguments) {
			call.args += delta.function.arguments;
		}
	}
}

/** 解析一个 chunk，失败时返回 null 并忽略该行 */
export function parseChunk(payload: string): WireChunk | null {
	try {
		return JSON.parse(payload) as WireChunk;
	} catch {
		return null;
	}
}

/** 拼接地址，避免出现重复斜杠 */
export function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
