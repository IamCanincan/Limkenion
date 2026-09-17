/**
 * DeepSeek API 客户端 —— 对齐 deepseek-harness packages/llm/llm-deepseek 的线上行为：
 *   - OpenAI 兼容 POST {baseURL}/chat/completions，SSE 流式
 *   - delta.content 文本流；delta.reasoning_content 思维链（V4 Pro 等思考模型）
 *   - 凭证从 DEEPSEEK_API_KEY 解析；缺失时抛 MISSING_CREDENTIAL
 *   - base URL 可用 DEEPSEEK_BASE_URL 覆盖（默认 https://api.deepseek.com）
 *
 * 模型目录取自 deepseek-harness 的 DEFAULT_MODELS。
 */

export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * 模型目录。
 *
 * **必须与 CLI 端对齐**（`utils/model/configs.ts` 的 `ALL_MODEL_CONFIGS`）——
 * 这是用户明确要求的"双端功能语义对齐"。
 *
 * 之前这里抄的是 deepseek-harness 的 `DEFAULT_MODELS`，列了 4 个，其中
 * `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 是**已退役的别名**
 * （官方说明：请求会被转发到 V4.1-Flash 并按 Flash 计费），而且
 * `MODELS[0]` 被当作默认模型 —— 于是 web 端默认用的竟是个退役别名，
 * 和 CLI 的默认（deepseek-flash）不一致。
 *
 * 以实测 `GET https://api.deepseek.com/models` 为准：只有下面两个。
 */
export const DEEPSEEK_MODELS = [
  { value: 'deepseek-flash', label: 'DeepSeek Flash', description: '快速、经济，适合日常任务；支持图像输入' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: '更强推理与复杂编码，含思维链；不支持图像' },
]

export function getApiKey() {
  return process.env[API_KEY_ENV] ?? null
}

/**
 * 流式对话补全（含函数调用）。
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array<{role: 'system'|'user'|'assistant'|'tool', content: string, tool_calls?: object[], tool_call_id?: string}>} opts.messages 完整对话历史
 * @param {Array<object>} [opts.tools] OpenAI function-calling 工具 schema
 * @param {(ev: {type: 'text'|'reasoning'|'tool_call', delta: string, toolCall?: object}) => void} opts.onDelta 流式增量
 * @param {AbortSignal} [opts.signal] 取消信号
 * @param {string} [opts.reasoningEffort] 推理强度。实测 DeepSeek 接受
 *   `none|minimal|low|medium|high|max`（`auto` 会 400）；`none` 是唯一能关掉思考链的取值。
 *   不传则由服务端默认（deepseek-flash 默认就是开思考）。
 * @returns {Promise<{usage: {inputTokens: number, outputTokens: number}, toolCalls: Array<{id: string, name: string, arguments: string}>, text: string}>}
 */
export async function chatCompletion({ model, messages, tools, onDelta, signal, reasoningEffort }) {
  const apiKey = getApiKey()
  if (!apiKey) {
    const err = new Error(`缺少 ${API_KEY_ENV} 环境变量。请设置后重启服务：set ${API_KEY_ENV}=sk-...`)
    err.code = 'MISSING_CREDENTIAL'
    throw err
  }

  // 请求体集中构造。
  //
  // 这里曾经出过一个**严重 bug**：body 构造在这个对象里（含 tools），
  // 但下面的 fetch 又手写了一份内联字面量（不含 tools），于是工具 schema
  // 从来没发给过模型 —— 模型永远调不了工具，web 端的 agent 实际只能聊天。
  // 现在只保留这一份 body，fetch 直接引用它。
  const body = {
    model,
    messages,
    stream: true,
    // stream_options 让 API 在最后一个 chunk 回报累计 usage
    stream_options: { include_usage: true },
  }
  if (tools?.length) body.tools = tools
  if (reasoningEffort) body.reasoning_effort = reasoningEffort

  let response
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    const err = new Error(`DeepSeek API 请求失败（${DEEPSEEK_BASE_URL}）：${String(error)}`)
    err.code = 'TRANSPORT'
    throw err
  }

  if (!response.ok) {
    let message = `DeepSeek API 错误（HTTP ${response.status}）`
    try {
      const parsed = await response.json()
      if (parsed?.error?.message) message = parsed.error.message
    } catch {
      // 网关返回非 JSON 时以状态码为准
    }
    const err = new Error(message)
    err.code = `HTTP_${response.status}`
    throw err
  }

  // --- SSE 解析（与 llm-deepseek translate.ts 相同的事件顺序） ---
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = { inputTokens: 0, outputTokens: 0 }
  // tool_calls 流式累积：按 delta.tool_calls[].index 聚合 id/name/arguments 片段
  const toolCallAcc = new Map()
  // 正文也在这里累积并随返回值给出。
  // 之前只经 onDelta 往外抛、返回值里没有 text，于是 engine.mjs 里
  // `const res = await chatCompletion(...); return res.text ?? null`
  // （WebFetch 的网页提炼器）永远拿到 undefined —— 提炼器静默失效。
  let text = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // 末行可能不完整，留待下轮

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith(':')) continue // 空行 / 注释心跳
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue

      let chunk
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue // 容忍畸形 chunk
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {}
        // 思维链在前，正文在后（思考模型的交错顺序）
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          onDelta({ type: 'reasoning', delta: delta.reasoning_content })
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content
          onDelta({ type: 'text', delta: delta.content })
        }
        for (const call of delta.tool_calls ?? []) {
          let acc = toolCallAcc.get(call.index)
          if (!acc) {
            acc = { id: '', name: '', arguments: '' }
            toolCallAcc.set(call.index, acc)
          }
          if (call.id) acc.id = call.id
          if (call.function?.name) acc.name = call.function.name
          if (call.function?.arguments) {
            acc.arguments += call.function.arguments
            onDelta({ type: 'tool_call', delta: call.function.arguments, toolCall: { index: call.index, name: acc.name } })
          }
        }
      }
    }
  }

  const toolCalls = [...toolCallAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: acc.arguments }))

  return { usage, toolCalls, text }
}
