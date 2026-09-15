/**
 * limkenion-ai 公共导出。
 *
 * 本包只做一件事：把 DeepSeek 的流式 HTTP 接口翻译成带类型的异步事件流。
 * 不包含会话、工具执行等策略，那些属于上层；只有请求层的重试留在这里，
 * 因为「限速了要不要再来一次」是传输层的决定。
 */

export {
	API_KEY_ENV,
	BASE_URL_ENV,
	MODEL_ENV,
	readApiKey,
	readBaseUrlOverride,
	readModelOverride,
} from "./env.ts";
export {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL_ID,
	KNOWN_MODELS,
	listModelIds,
	type Model,
	resolveModel,
} from "./models.ts";
export {
	DEFAULT_RETRIES,
	isRetryableError,
	isRetryableStatus,
	parseRetryAfter,
	RETRY_AFTER_MAX_MS,
	RETRY_BASE_MS,
	RETRY_MAX_DELAY_MS,
	type RetryOptions,
	retryDelayMs,
} from "./retry.ts";
export { type ChatRequest, describeError, SSE_IDLE_TIMEOUT_MS, streamChat } from "./stream.ts";
export type {
	AssistantMessage,
	ChatErrorCode,
	ChatEvent,
	Message,
	SystemMessage,
	ToolCall,
	ToolMessage,
	ToolResult,
	ToolSpec,
	Usage,
	UserMessage,
} from "./types.ts";
export {
	accumulateToolCalls,
	buildBody,
	joinUrl,
	parseChunk,
	SSE_DATA_PREFIX,
	SSE_DONE,
	toUsage,
	toWireMessages,
	type WireChunk,
	type WireRequest,
} from "./wire.ts";
