/**
 * OpenAI 兼容适配器 —— 让 Limkenion 可以走 DeepSeek / 任何 OpenAI 格式端点，
 * 不再依赖 上游 SDK。
 *
 * 设计要点：
 * - 上层（queryModel 的调用方）期望的是 **上游 风格**的 AssistantMessage
 *   （message.content 是 block 数组：text / tool_use / thinking）。
 *   所以这里做双向翻译：请求 上游->OpenAI，响应 OpenAI->上游。
 *   这样上层一行都不用改。
 * - 上游 专有能力（prompt caching / extended thinking / beta headers /
 *   advisor / bedrock-vertex provider）在 OpenAI 协议下没有对应物，直接忽略。
 *
 * 启用方式：设置环境变量
 *   LIMKENION_API_PROVIDER=openai
 *   DEEPSEEK_API_KEY / OPENAI_API_KEY
 *   DEEPSEEK_BASE_URL / OPENAI_BASE_URL  （默认 https://api.deepseek.com）
 */

import OpenAI from 'openai'
import { getGlobalConfig } from '../../utils/config.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**  endpoints 默认值 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'

/**
 * 取 /login 保存下来的 key（全局配置的 primaryApiKey）。
 *
 * 放在环境变量**之后**：环境变量是显式覆盖，优先级更高。
 * 用 try/catch 包住 —— 配置在 bootstrap 完成前被读取会抛
 * "Config accessed before allowed"，那不是致命错误，当作没有 key 即可。
 */
function getStoredApiKey(): string {
  try {
    return getGlobalConfig().primaryApiKey ?? ''
  } catch {
    return ''
  }
}

function getConfig() {
  return {
    apiKey:
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.LIMKENION_API_KEY ||
      getStoredApiKey() ||
      '',
    baseURL:
      process.env.DEEPSEEK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.LIMKENION_BASE_URL ||
      DEFAULT_BASE_URL,
    model: process.env.LIMKENION_MODEL || DEFAULT_MODEL,
    // 推理强度：low / medium / high（对应 codex 的 reasoning.effort，
    // 也是 上游 extended thinking 在 OpenAI 协议下的等效物）。
    // 仅对支持该参数的模型（OpenAI o-series / gpt-5+、部分兼容网关）生效。
    // 运行时 set 优先于 env，其次默认空（见对 getRuntimeReasoningEffort 的调用）。
    reasoningEffort: getRuntimeReasoningEffort(),
  }
}

/**
 * 模块内可变的推理强度（low / medium / high），可会话中切换、不重启。
 * 优先级：运行时 set > REASONING_EFFORT env > 设置文件里的 effortLevel > 空。
 */
let runtimeReasoningEffort: string | undefined

export function setRuntimeReasoningEffort(value: string | undefined): void {
  runtimeReasoningEffort = value
}

/**
 * 从设置文件里读 `/effort` 存下的推理强度。
 *
 * **这里原本是个断点**：`/effort high` 会把值写进 settings.json、界面上还会显示
 * 一个小图标，但 API 只读 `runtimeReasoningEffort`（只有 `/model low|medium|high`
 * 会设置它）—— 也就是说 **`/effort` 是个空操作，给了用户假承诺**。
 * 现在补上这一层回落，两个命令都能真正生效。
 *
 * 惰性读取（不在模块顶层调用），所以即使 settings 那条依赖链里有环也没关系。
 */
function getPersistedReasoningEffort(): string | undefined {
  try {
    const level = getInitialSettings().effortLevel
    // DeepSeek 的 reasoning_effort 只接受这三档（'max' 是上游概念，会被过滤掉）
    return level === 'low' || level === 'medium' || level === 'high'
      ? level
      : undefined
  } catch {
    // 设置尚未加载时静默跳过，不要因为一个可选参数炸掉整个请求
    return undefined
  }
}

export function getRuntimeReasoningEffort(): string {
  return (
    runtimeReasoningEffort ??
    process.env.REASONING_EFFORT ??
    getPersistedReasoningEffort() ??
    ''
  )
}

/** 上游 content block -> 纯文本（OpenAI 只接受字符串或 content part 数组） */
function blockToText(block: any): string {
  if (block == null) return ''
  if (typeof block === 'string') return block
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'tool_result': {
      // 工具结果：取其中的文本内容
      const c = block.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map(blockToText).join('')
      return typeof c === 'object' && c !== null ? JSON.stringify(c) : String(c ?? '')
    }
    case 'thinking':
      return ''
    case 'image':
      return ''
    default:
      return ''
  }
}

function contentToText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockToText).filter(Boolean).join('\n')
  if (typeof content === 'object') {
    // 可能是 { type:'text', text } 单块
    return blockToText(content)
  }
  return String(content)
}

/**
 * 上游 image block -> OpenAI 的 image_url part。
 * 支持 base64 与 url 两种 source。
 *
 * **实测（2026-09-18，用纯红色 64×64 图片验证）**：
 * - `deepseek-flash` **真的能看见** —— 正确回答「红色」
 * - `deepseek-v4-pro` **看不见** —— 会猜一个颜色（回答「白色」）而不是报错
 *
 * 所以这里不做模型分流：能不能看图由调用方选的模型决定，我们不静默丢图。
 */
function imageBlockToOpenAIPart(block: any): any | null {
  const src = block?.source
  if (!src) return null
  if (src.type === 'base64' && src.data) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${src.media_type ?? 'image/png'};base64,${src.data}`,
      },
    }
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } }
  }
  return null
}

/**
 * 上游 content -> OpenAI 的 content 字段。
 *
 * **没有图片时返回字符串**（兼容性最好，也省 token）；
 * **有图片时返回 content part 数组**（OpenAI 的图文混排格式）。
 * 这是图片能真正送达模型的关键 —— 之前这里对 image block 返回空串，
 * 等于把图片静默丢掉了。
 */
function contentToOpenAIContent(content: any): string | any[] {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return contentToText(content)

  const parts: any[] = []
  let hasImage = false
  for (const b of content) {
    if (b?.type === 'image') {
      const part = imageBlockToOpenAIPart(b)
      if (part) {
        parts.push(part)
        hasImage = true
      }
      continue
    }
    const t = blockToText(b)
    if (t) parts.push({ type: 'text', text: t })
  }

  if (!hasImage) return parts.map(p => p.text).join('\n')
  return parts
}

/**
 * Limkenion 消息（上游 风格） -> OpenAI messages
 * Limkenion 每条消息形如 { type:'user'|'assistant', message:{ role, content:[blocks] }, uuid }
 */
export function toOpenAIMessages(messages: any[], systemPrompt: any): any[] {
  const out: any[] = []

  // system prompt：可能是 string，也可能是 block 数组
  const systemText = contentToText(
    typeof systemPrompt === 'string' ? systemPrompt : systemPrompt,
  )
  if (systemText) out.push({ role: 'system', content: systemText })

  for (const m of messages ?? []) {
    const inner = m?.message ?? m
    const role = inner?.role ?? m?.type

    if (role === 'user') {
      const content = inner?.content
      // 工具结果在 上游 里是 user message 里的 tool_result block
      if (Array.isArray(content)) {
        const toolResults = content.filter((b: any) => b?.type === 'tool_result')
        const payload = contentToOpenAIContent(
          content.filter((b: any) => b?.type !== 'tool_result'),
        )
        if (typeof payload === 'string' ? payload : payload.length > 0) {
          out.push({ role: 'user', content: payload })
        }
        for (const tr of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: contentToText(tr.content) || '(empty)',
          })
        }
      } else {
        const payload = contentToOpenAIContent(content)
        if (typeof payload === 'string' ? payload : payload.length > 0) {
          out.push({ role: 'user', content: payload })
        }
      }
      continue
    }

    if (role === 'assistant') {
      const content = inner?.content
      const textParts: string[] = []
      const toolCalls: any[] = []

      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') textParts.push(b.text ?? '')
          else if (b?.type === 'tool_use') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            })
          }
          // thinking / redacted_thinking 忽略
        }
      } else {
        const t = contentToText(content)
        if (t) textParts.push(t)
      }

      const msg: any = { role: 'assistant', content: textParts.join('') || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      out.push(msg)
      continue
    }
  }

  return out
}

/** Limkenion 工具（上游: name/description/inputSchema） -> OpenAI functions */
export function toOpenAITools(tools: any): any[] | undefined {
  const list = Array.isArray(tools) ? tools : (tools?.tools ?? [])
  if (!Array.isArray(list) || list.length === 0) return undefined

  const out = list
    .filter((t: any) => t && t.name)
    .map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? t.input_schema ?? { type: 'object', properties: {} },
        // 结构化输出（严格模式）：让模型严格按 schema 产出参数。
        // 上游那边是靠 beta 头开启的；OpenAI 协议里就是 function 上的 strict 字段。
        // 实测 DeepSeek 两个模型都接受它。
        ...(t.strict === true ? { strict: true } : {}),
      },
    }))
    // 按名字排序，保证每轮请求里 tools 数组的顺序完全一致。
    // OpenAI 按「前缀」做自动缓存：system + tools 逐字节一致才会命中，
    // 顺序抖动会让缓存整体失效（codex 里对应 prompt_cache_key 的稳定性要求）。
    .sort((a: any, b: any) => a.function.name.localeCompare(b.function.name))

  return out.length ? out : undefined
}

/**
 * 上游 tool_choice -> OpenAI tool_choice
 * - {type:'auto'}          -> 'auto'
 * - {type:'any'}           -> 'required'
 * - {type:'none'}          -> 'none'
 * - {type:'tool',name:'x'} -> {type:'function',function:{name:'x'}}
 *   （权限解释器 / 权限判定器靠这个强制拿结构化输出，必须支持）
 */
function toOpenAIToolChoice(toolChoice: any): any | undefined {
  if (!toolChoice) return undefined
  if (typeof toolChoice === 'string') return toolChoice
  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return toolChoice.name
        ? { type: 'function', function: { name: toolChoice.name } }
        : undefined
    default:
      return undefined
  }
}

/**
 * 调用 OpenAI 兼容端点，产出 **上游 风格**的 AssistantMessage，
 * 使上层无需改动。
 */
export async function* queryOpenAICompat({
  messages,
  systemPrompt,
  tools,
  toolChoice,
  stopSequences,
  signal,
  model,
  maxTokens,
  temperature,
}: {
  messages: any[]
  systemPrompt: any
  tools: any
  toolChoice?: any
  stopSequences?: string[]
  signal?: AbortSignal
  model?: string
  maxTokens?: number
  temperature?: number
}): AsyncGenerator<any, void> {
  const cfg = getConfig()
  if (!cfg.apiKey) {
    throw new Error(
      '尚未配置 API Key。请运行 /login 输入 DeepSeek API Key，' +
        '或设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量后重启。',
    )
  }

  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })

  const oaiMessages = toOpenAIMessages(messages, systemPrompt)
  const oaiTools = toOpenAITools(tools)

  const request: any = {
    model: model || cfg.model,
    messages: oaiMessages,
    stream: true,
  }
  if (oaiTools) {
    request.tools = oaiTools
    // 未显式指定时默认 auto；指定了强制工具就翻译过去。
    request.tool_choice = toOpenAIToolChoice(toolChoice) ?? 'auto'
  }
  if (maxTokens) request.max_tokens = maxTokens
  if (typeof temperature === 'number') request.temperature = temperature
  if (Array.isArray(stopSequences) && stopSequences.length > 0) {
    request.stop = stopSequences
  }
  // 推理强度（等效于 上游 的 extended thinking / codex 的 reasoning.effort）
  //
  // 但有个硬约束：DeepSeek 在推理模式下拒绝强制 tool_choice，会返回
  // 400 "Thinking mode does not support this tool_choice"。而权限解释器 /
  // 权限自动判定 / 结构化输出这类调用恰恰靠强制工具拿结果 —— 所以一旦指定了
  // 强制工具就必须关掉推理（实测 reasoning_effort:'none' 可关闭思考链）。
  const isForcedToolChoice =
    toolChoice != null &&
    typeof toolChoice === 'object' &&
    (toolChoice as any).type === 'tool'
  if (isForcedToolChoice) {
    request.reasoning_effort = 'none'
  } else if (cfg.reasoningEffort) {
    request.reasoning_effort = cfg.reasoningEffort
  }

  const stream: any = await client.chat.completions.create(request, {
    ...(signal ? { signal } : {}),
  })

  // 流式累积
  let text = ''
  let thinking = ''
  const toolCallMap = new Map<number, { id?: string; name?: string; args: string }>()
  let finishReason: string | undefined
  let usage: any

  for await (const chunk of stream) {
    const choice = chunk?.choices?.[0]
    if (!choice) {
      if (chunk?.usage) usage = chunk.usage
      continue
    }
    const delta = choice.delta ?? {}
    // 思维链在前，正文在后（参考 web/server/deepseek.mjs 的消费顺序）。
    // 思考增量作为独立的 thinking_delta 流事件输出，交由上层展示；
    // 不会混入下面的正文累积，也不影响 tool_calls 累积。
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      thinking += delta.reasoning_content
      yield { type: 'thinking_delta', thinking: delta.reasoning_content }
    }
    if (typeof delta.content === 'string' && delta.content) text += delta.content

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const cur = toolCallMap.get(idx) ?? { args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        toolCallMap.set(idx, cur)
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason
    if (chunk?.usage) usage = chunk.usage
  }

  // 组装 上游 风格 content blocks
  const content: any[] = []
  // 思考链单独成块，避免混入正文文本
  if (thinking) content.push({ type: 'thinking', thinking })
  if (text) content.push({ type: 'text', text })

  for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
    let input: any = {}
    try {
      input = tc.args ? JSON.parse(tc.args) : {}
    } catch {
      input = {}
    }
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.name ?? '',
      input,
    })
  }

  const stopReason =
    finishReason === 'tool_calls'
      ? 'tool_use'
      : finishReason === 'length'
        ? 'max_tokens'
        : 'end_turn'

  yield {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    message: {
      // 补齐 BetaMessage 的基本字段：sideQuery 的调用方会把它当 BetaMessage 用。
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model: model || cfg.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        // OpenAI 系前缀缓存命中的 token 数（自动缓存，无需显式标记）。
        // 便于在 /cost 等处观察是否真的命中缓存。
        cache_read_input_tokens:
          usage?.prompt_tokens_details?.cached_tokens ??
          usage?.cached_tokens ??
          0,
      },
    },
  }
}

/** 非流式版本（供需要 Promise 的调用点使用） */
export async function queryOpenAICompatOnce(
  args: Parameters<typeof queryOpenAICompat>[0],
): Promise<any> {
  for await (const msg of queryOpenAICompat(args)) {
    if (msg?.type === 'assistant') return msg
  }
  throw new Error('OpenAI 兼容请求未返回 assistant 消息')
}
