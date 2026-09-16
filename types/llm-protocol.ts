/**
 * 本地 LLM 协议类型 —— 取代原先从 `@limkenion-ai/sdk`（上游 SDK）导入的符号。
 *
 * 目的：源码不再依赖任何 上游 包。消息/工具/错误的**形状**保持与原来一致，
 * 因此上层代码无需改动；但类型定义改由本仓库自己持有，可随协议演进自由调整。
 *
 * 说明：
 * - 内容块（text / image / tool_use / tool_result / thinking）按结构定义，
 *   因为它们是消息模型的核心，代码里会按字段访问。
 * - 流式/请求参数类结构较深且只在少数路径用到，这里给出宽松但具名的定义，
 *   避免为了 1% 的精度引入 100% 的耦合。
 * - 错误类必须是真实类：代码里有 `instanceof` 判断和 `.status` 访问。
 */

// ---------------------------------------------------------------------------
// 基础内容块
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text'
  text: string
  citations?: unknown[] | null
}

export interface ImageBlock {
  type: 'image'
  source: Base64ImageSource | { type: 'url'; url: string }
}

export interface Base64ImageSource {
  type: 'base64'
  media_type: string
  data: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | ContentBlock[] | unknown
  is_error?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | { type: string; [k: string]: unknown }

/** 请求侧的内容块（字段可选性更宽松） */
export type ContentBlockParam =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'image'; source: unknown; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean; [k: string]: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: string; [k: string]: unknown }

export type TextBlockParam = { type: 'text'; text: string; [k: string]: unknown }
export type ImageBlockParam = { type: 'image'; source: unknown; [k: string]: unknown }
export type ToolUseBlockParam = { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
export type ToolResultBlockParam = {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
  [k: string]: unknown
}
export type ThinkingBlockParam = { type: 'thinking'; thinking: string; signature?: string }
export type RedactedThinkingBlockParam = { type: 'redacted_thinking'; data: string }

// ---------------------------------------------------------------------------
// Beta 变体（历史命名，形状与非 Beta 版一致）
// ---------------------------------------------------------------------------

export type BetaContentBlock = ContentBlock
export type BetaContentBlockParam = ContentBlockParam
export type BetaImageBlockParam = ImageBlockParam
export type BetaThinkingBlock = ThinkingBlock
export type BetaRedactedThinkingBlock = RedactedThinkingBlock
export type BetaToolUseBlock = ToolUseBlock
export type BetaToolResultBlockParam = ToolResultBlockParam
export type BetaRequestDocumentBlock = { type: 'document'; source: unknown; [k: string]: unknown }

export interface BetaUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  [k: string]: unknown
}

export type BetaMessageDeltaUsage = Partial<BetaUsage>
export type BetaStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | string

export interface BetaMessage {
  id?: string
  type: 'message'
  role: 'assistant' | 'user'
  model: string
  content: ContentBlock[]
  stop_reason?: BetaStopReason | null
  usage?: BetaUsage
  [k: string]: unknown
}

export type BetaMessageParam = {
  role: 'user' | 'assistant'
  content: string | ContentBlockParam[]
  [k: string]: unknown
}

export type MessageParam = BetaMessageParam

export interface BetaMessageStreamParams {
  model: string
  messages: MessageParam[]
  max_tokens: number
  system?: string | ContentBlockParam[]
  temperature?: number
  tools?: unknown[]
  [k: string]: unknown
}

export type BetaRawMessageStreamEvent = {
  type: string
  [k: string]: unknown
}

export type BetaJSONOutputFormat = {
  type: 'json_schema'
  schema: Record<string, unknown>
  [k: string]: unknown
}

export type BetaOutputConfig = { format?: unknown; [k: string]: unknown }

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export interface BetaTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  [k: string]: unknown
}

export type BetaToolUnion = BetaTool | BetaWebSearchTool20250305
export type BetaWebSearchTool20250305 = {
  type: 'web_search_20250305'
  name: 'web_search'
  [k: string]: unknown
}
export type BetaToolChoiceAuto = { type: 'auto'; [k: string]: unknown }
export type BetaToolChoiceTool = { type: 'tool'; name: string; [k: string]: unknown }

// ---------------------------------------------------------------------------
// 错误类（必须是真实类：代码依赖 instanceof / .status）
// ---------------------------------------------------------------------------

export class APIError extends Error {
  status: number | undefined
  headers: unknown
  constructor(message?: string, status?: number) {
    super(message ?? 'API error')
    this.name = 'APIError'
    this.status = status
  }
}

export class APIConnectionError extends APIError {
  constructor(message?: string) {
    super(message ?? 'Connection error', undefined)
    this.name = 'APIConnectionError'
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor(message?: string) {
    super(message ?? 'Connection timed out')
    this.name = 'APIConnectionTimeoutError'
  }
}

export class APIUserAbortError extends APIError {
  constructor(message?: string) {
    super(message ?? 'Request aborted', undefined)
    this.name = 'APIUserAbortError'
  }
}

export class AuthenticationError extends APIError {
  constructor(message?: string) {
    super(message ?? 'Authentication error', 401)
    this.name = 'AuthenticationError'
  }
}

export class NotFoundError extends APIError {
  constructor(message?: string) {
    super(message ?? 'Not found', 404)
    this.name = 'NotFoundError'
  }
}

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

export type ClientOptions = {
  apiKey?: string
  baseURL?: string
  maxRetries?: number
  [k: string]: unknown
}

export type Stream<T = unknown> = AsyncIterable<T> & {
  [k: string]: unknown
}

/**
 * 旧 上游 client 的占位。
 * OpenAI 兼容模式下不再使用它；若仍有遗留路径走到这里，抛出明确错误
 * 而不是静默失败，便于定位。
 */
export class Limkenion {
  readonly apiKey: string | undefined
  readonly baseURL: string | undefined

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey
    this.baseURL = options.baseURL
  }

  get beta(): never {
    throw new Error(
      '上游 client 已移除：当前运行在 OpenAI 兼容模式（LIMKENION_API_PROVIDER=openai）。' +
        '请改用 services/api/openai-compat.ts。',
    )
  }

  get messages(): never {
    throw new Error(
      '上游 client 已移除：当前运行在 OpenAI 兼容模式（LIMKENION_API_PROVIDER=openai）。',
    )
  }
}

// 旧代码里有 `import Limkenion from '@limkenion-ai/sdk'`（默认导入），
// 替换成本地模块后需要保留默认导出，否则 esbuild 报 No matching export。
export default Limkenion
