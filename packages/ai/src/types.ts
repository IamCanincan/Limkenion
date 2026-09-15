/**
 * 对话消息与流式事件的类型定义。
 *
 * 这里只描述「模型需要知道的东西」：消息、工具调用、用量。所有 provider 特有的字段
 * 都在 stream.ts 里翻译成这些类型，上层不需要关心线上格式。
 */

/** 工具调用请求，由模型发起。arguments 是模型生成的原始 JSON 字符串。 */
export interface ToolCall {
	/** 本次调用的唯一标识，回传工具结果时必须带上 */
	id: string;
	/** 工具名，必须与 ToolSpec.name 一致 */
	name: string;
	/** 原始 JSON 字符串，可能不合法，由调用方负责解析与校验 */
	arguments: string;
}

/** 工具执行结果，回传给模型 */
export interface ToolResult {
	/** 对应 ToolCall.id */
	toolCallId: string;
	/** 结果正文，通常是命令输出或文件内容 */
	content: string;
	/** 是否执行失败。失败也必须回传，否则模型会一直重试同一个调用 */
	isError: boolean;
}

/** 系统提示消息 */
export interface SystemMessage {
	role: "system";
	content: string;
}

/** 用户消息 */
export interface UserMessage {
	role: "user";
	content: string;
}

/** 助手消息。reasoning 是思维链正文，需要原样回传以支持多轮工具调用。 */
export interface AssistantMessage {
	role: "assistant";
	content: string;
	reasoning: string;
	toolCalls: ToolCall[];
}

/** 工具结果消息，可一次携带同一轮的多个结果 */
export interface ToolMessage {
	role: "tool";
	results: ToolResult[];
}

/** 对话历史中的一个元素 */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** 暴露给模型的工具描述，parameters 是 JSON Schema 对象 */
export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** token 用量，provider 未返回时为 null */
export interface Usage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/**
	 * 其中命中上下文缓存的部分。
	 *
	 * 线上没回报时是 undefined（不是 0）——两者含义不同：0 是「回报了，一个都没命中」，
	 * undefined 是「这条信息不存在」。界面据此决定要不要显示命中率，别拿 0 编一个 0% 出来。
	 */
	cachedTokens?: number;
}

/**
 * 调用失败的原因分类。
 *
 * 上层（比如界面上那个「重试」按钮）据此决定该给用户什么操作，不必去解析中文文案。
 * code 说明「哪里错了」，再试一次有没有用由 ChatEvent 里的 retryable 表达。
 */
export type ChatErrorCode =
	/** 用户主动取消 */
	| "cancelled"
	/** 连接层失败：DNS、连接被拒、重置、超时 */
	| "network"
	/** 非 2xx */
	| "http"
	/** 响应没有正文，无法解析 SSE */
	| "empty_body"
	/** 读循环自然收尾，却既没有 [DONE] 也没有 finish_reason */
	| "stream_truncated"
	/** 空闲看门狗把它断了 */
	| "stream_idle_timeout"
	/** 读流过程中抛错 */
	| "stream_read"
	/** 服务端在流里回传了 error chunk */
	| "server_error";

/**
 * 流式对话事件。
 *
 * tool_call 只在整条调用参数收集完整后才发出，调用方不需要自己拼接增量分片。
 */
export type ChatEvent =
	/** 思维链增量 */
	| { type: "reasoning"; delta: string }
	/** 正文增量 */
	| { type: "text"; delta: string }
	/** 一条参数已完整的工具调用 */
	| { type: "tool_call"; call: ToolCall }
	/** 本轮结束 */
	| { type: "done"; reason: string; usage: Usage | null }
	/** 调用失败，本轮不会再有其它事件 */
	| {
			type: "error";
			/** 给用户看的文案；保持中文原样，调用方不要去解析它 */
			message: string;
			/** 机器可读的失败分类 */
			code: ChatErrorCode;
			/** 再试一次是否可能成功：code 描述事实，它描述建议 */
			retryable: boolean;
			/** 只有 http 失败才带：上游返回的状态码 */
			status?: number;
			/** 上游要求等待的毫秒数（来自 Retry-After）；解析不出来时整个字段不出现 */
			retryAfterMs?: number;
	  };
