import type { BetaUsage as Usage } from '../types/llm-protocol.js'
import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from './messages.js'
import { jsonStringify } from './slowOperations.js'

export function getTokenUsage(message: Message): Usage | undefined {
  if (
    message?.type === 'assistant' &&
    'usage' in message.message &&
    !(
      message.message.content[0]?.type === 'text' &&
      SYNTHETIC_MESSAGES.has(message.message.content[0].text)
    ) &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.usage
  }
  return undefined
}

/**
 * 获取带真实（非合成的）使用量的助手消息的 API 响应 id。
 * 用于识别来自同一次 API 响应的拆分助手记录——
 * 当并行工具调用被流式传输时，每个内容块会变成一条独立
 * 的 AssistantMessage 记录，但它们共享同一个 message.id。
 */
function getAssistantMessageId(message: Message): string | undefined {
  if (
    message?.type === 'assistant' &&
    'id' in message.message &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.id
  }
  return undefined
}

/**
 * 从 API 响应的使用量数据计算总上下文窗口 token 数。
 * 包括 input_tokens + 缓存 token + output_tokens。
 *
 * 这表示该次 API 调用时点的完整上下文大小。
 * 需要在基于消息计算上下文大小时使用 tokenCountWithEstimation()。
 */
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return getTokenCountFromUsage(usage)
    }
    i--
  }
  return 0
}

/**
 * 来自最后一次 API 响应的 usage.iterations[-1] 的最终上下文窗口大小。
 * 用于跨压缩边界计算 task_budget.remaining——服务器的预算倒计时
 * 基于上下文，因此 remaining 按压缩前的最终窗口递减，而非按计费开销。
 * 参见 monorepo api/api/sampling/prompt/renderer.py:292 的服务端计算。
 *
 * iterations 缺失时（没有服务端工具循环，因此顶层使用量就是最终窗口）
 * 回退到顶层 input_tokens + output_tokens。
 * 两条路径都排除缓存 token，以匹配 #304930 的公式。
 */
export function finalContextTokensFromLastResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      // Stainless 类型尚不含 iterations——像 advisor.ts:43 那样强转
      const iterations = (
        usage as {
          iterations?: Array<{
            input_tokens: number
            output_tokens: number
          }> | null
        }
      ).iterations
      if (iterations && iterations.length > 0) {
        const last = iterations.at(-1)!
        return last.input_tokens + last.output_tokens
      }
      // 无 iterations → 无服务端工具循环 → 顶层使用量就是最终
      // 窗口。匹配 iterations 路径的公式（input + output，不含缓存）
      // 而非 getTokenCountFromUsage——#304930 把最终窗口定义为
      // 非缓存 input + output。服务器的预算倒计时
      // （renderer.py:292 calculate_context_tokens）是否以相同方式
      // 计数缓存是个悬而未决的问题；与该路径保持一致可使两个
      // 分支在解决前保持一致。
      return usage.input_tokens + usage.output_tokens
    }
    i--
  }
  return 0
}

/**
 * 只取最后一次 API 响应的 output_tokens。
 * 这排除了输入上下文（系统提示、工具、先前消息）。
 *
 * 警告：不要用它做阈值比较（自动压缩、会话内存）。
 * 改用 tokenCountWithEstimation()，它测量完整上下文大小。
 * 此函数只对测量 Limkenion 在单次响应中生成了多少 token 有用，
 * 而非上下文窗口有多满。
 */
export function messageTokenCountFromLastAPIResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return usage.output_tokens
    }
    i--
  }
  return 0
}

export function getCurrentUsage(messages: Message[]): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      }
    }
  }
  return null
}

export function doesMostRecentAssistantMessageExceed200k(
  messages: Message[],
): boolean {
  const THRESHOLD = 200_000

  const lastAsst = messages.findLast(m => m.type === 'assistant')
  if (!lastAsst) return false
  const usage = getTokenUsage(lastAsst)
  return usage ? getTokenCountFromUsage(usage) > THRESHOLD : false
}

/**
 * 计算一条助手消息的字符内容长度。
 * 用于 spinner token 估算（字符数 / 4 ≈ token 数）。
 * 当子 agent 流式事件被过滤掉、我们需要从已完成的
 * 消息中计数内容时使用。
 *
 * 计数与 handleMessageFromStream 会通过增量计数相同的内容：
 * - text（text_delta）
 * - thinking（thinking_delta）
 * - redacted_thinking 数据
 * - tool_use 输入（input_json_delta）
 * 注意：signature_delta 从流式计数中排除（非模型输出）。
 */
export function getAssistantMessageContentLength(
  message: AssistantMessage,
): number {
  let contentLength = 0
  for (const block of message.message.content) {
    if (block.type === 'text') {
      contentLength += block.text.length
    } else if (block.type === 'thinking') {
      contentLength += block.thinking.length
    } else if (block.type === 'redacted_thinking') {
      contentLength += block.data.length
    } else if (block.type === 'tool_use') {
      contentLength += jsonStringify(block.input).length
    }
  }
  return contentLength
}

/**
 * 获取当前上下文窗口大小（以 token 计）。
 *
 * 这是检查阈值（自动压缩、会话内存初始化等）时测量上下文大小的
 * CANONICAL 函数。使用最后一次 API 响应的 token 数
 * （input + output + 缓存）加上对其后新增消息的估算。
 *
 * 始终用它而不是：
 * - 累积 token 计数（随上下文增长会重复计数）
 * - messageTokenCountFromLastAPIResponse（只计 output_tokens）
 * - tokenCountFromLastAPIResponse（不估算新消息）
 *
 * 关于并行工具调用的实现说明：当模型在单次响应中发出多个工具调用时，
 * 流式代码为每个内容块发出一条独立的助手记录（共享相同的 message.id 和
 * usage），查询循环把每个 tool_result 紧接其 tool_use 交错地插入。
 * 因此消息数组看起来像：
 *   [..., assistant(id=A), user(result), assistant(id=A), user(result), ...]
 * 如果我们停在最后一条助手记录处，就只估算其后的那一个 tool_result，
 * 而漏掉所有更早的交错 tool_result——它们都会进入下一次 API 请求。
 * 为避免少计，在找到一条带 usage 的记录后，我们回退到具有相同
 * message.id 的首个兄弟记录，使每个交错的 tool_result 都被计入
 * 粗略估算。
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (message && usage) {
      // 回退经过同一 API 响应中拆出的更早兄弟记录（相同 message.id），
      // 使它们之间交错的 tool_results 被包含进估算切片。
      const responseId = getAssistantMessageId(message)
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const prior = messages[j]
          const priorId = prior ? getAssistantMessageId(prior) : undefined
          if (priorId === responseId) {
            // 同一次 API 响应更早的拆分——在此锚定。
            i = j
          } else if (priorId !== undefined) {
            // 命中不同的 API 响应——停止回退。
            break
          }
          // priorId === undefined：用户/tool_result/附件消息，
          // 可能交错在拆分之间——继续回退。
          j--
        }
      }
      return (
        getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(messages.slice(i + 1))
      )
    }
    i--
  }
  return roughTokenCountEstimationForMessages(messages)
}
