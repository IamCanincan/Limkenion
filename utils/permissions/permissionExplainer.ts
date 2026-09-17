import { z } from 'zod/v4'
import { logEvent } from '../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import { getMainLoopModel } from '../model/model.js'
import { sideQuery } from '../sideQuery.js'
import { jsonStringify } from '../slowOperations.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

// 将风险等级映射为数值，供埋点使用
const RISK_LEVEL_NUMERIC: Record<RiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
}

// 用于埋点的错误类型编码
const ERROR_TYPE_PARSE = 1
const ERROR_TYPE_NETWORK = 2
const ERROR_TYPE_UNKNOWN = 3

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

type GenerateExplanationParams = {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
  signal: AbortSignal
}

const SYSTEM_PROMPT = `分析 shell 命令，说明它们的用途、你运行它们的原因以及潜在风险。`

// 用于强制结构化输出的工具定义（无需 beta）
const EXPLAIN_COMMAND_TOOL = {
  name: 'explain_command',
  description: '对某条 shell 命令给出解释',
  input_schema: {
    type: 'object' as const,
    properties: {
      explanation: {
        type: 'string',
        description: '这条命令的作用（1-2 句话）',
      },
      reasoning: {
        type: 'string',
        description:
          '你运行这条命令的原因。以"我"开头——例如"我需要检查文件内容"',
      },
      risk: {
        type: 'string',
        description: '可能出错的地方，15 字以内',
      },
      riskLevel: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH'],
        description:
          'LOW（安全的开发流程）、MEDIUM（可恢复的变更）、HIGH（危险/不可逆）',
      },
    },
    required: ['explanation', 'reasoning', 'risk', 'riskLevel'],
  },
}

// 用于解析并验证响应的 Zod schema
const RiskAssessmentSchema = lazySchema(() =>
  z.object({
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    explanation: z.string(),
    reasoning: z.string(),
    risk: z.string(),
  }),
)

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }
  try {
    return jsonStringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/**
 * 从消息中提取近期对话上下文供解释器使用。
 * 返回最近的助手消息摘要以提供"为什么要运行这条命令"的上下文。
 */
function extractConversationContext(
  messages: Message[],
  maxChars = 1000,
): string {
  // 取最近的助手消息（其中包含 Limkenion 的推理过程）
  const assistantMessages = messages
    .filter((m): m is AssistantMessage => m.type === 'assistant')
    .slice(-3) // 最近的 3 条助手消息

  const contextParts: string[] = []
  let totalChars = 0

  for (const msg of assistantMessages.reverse()) {
    // 从助手消息中提取文本内容
    const textBlocks = msg.message.content
      .filter(c => c.type === 'text')
      .map(c => ('text' in c ? c.text : ''))
      .join(' ')

    if (textBlocks && totalChars < maxChars) {
      const remaining = maxChars - totalChars
      const truncated =
        textBlocks.length > remaining
          ? textBlocks.slice(0, remaining) + '...'
          : textBlocks
      contextParts.unshift(truncated)
      totalChars += truncated.length
    }
  }

  return contextParts.join('\n\n')
}

/**
 * 检查权限解释器功能是否启用。
 * 默认启用；用户可通过配置关闭。
 */
export function isPermissionExplainerEnabled(): boolean {
  return getGlobalConfig().permissionExplainerEnabled !== false
}

/**
 * 使用 Haiku 结合结构化输出生成权限解释。
 * 当功能被禁用、请求被中止或发生错误时返回 null。
 */
export async function generatePermissionExplanation({
  toolName,
  toolInput,
  toolDescription,
  messages,
  signal,
}: GenerateExplanationParams): Promise<PermissionExplanation | null> {
  // 检查功能是否启用
  if (!isPermissionExplainerEnabled()) {
    return null
  }

  const startTime = Date.now()

  try {
    const formattedInput = formatToolInput(toolInput)
    const conversationContext = messages?.length
      ? extractConversationContext(messages)
      : ''

    const userPrompt = `工具：${toolName}
${toolDescription ? `描述：${toolDescription}\n` : ''}
输入：
${formattedInput}
${conversationContext ? `\n近期对话上下文：\n${conversationContext}` : ''}

请结合上下文解释这条命令。`

    const model = getMainLoopModel()

    // 使用 sideQuery 配合强制工具选择以确保结构化输出
    const response = await sideQuery({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [EXPLAIN_COMMAND_TOOL],
      tool_choice: { type: 'tool', name: 'explain_command' },
      signal,
      querySource: 'permission_explainer',
    })

    const latencyMs = Date.now() - startTime
    logForDebugging(
      `权限解释器：API 在 ${latencyMs}ms 内返回，stop_reason=${response.stop_reason}`,
    )

    // 从工具使用块中提取结构化数据
    const toolUseBlock = response.content.find(c => c.type === 'tool_use')
    if (toolUseBlock && toolUseBlock.type === 'tool_use') {
      logForDebugging(
        `权限解释器：失败输入 ${jsonStringify(toolUseBlock.input).slice(0, 500)}`,
      )
      const result = RiskAssessmentSchema().safeParse(toolUseBlock.input)

      if (result.success) {
        const explanation: PermissionExplanation = {
          riskLevel: result.data.riskLevel,
          explanation: result.data.explanation,
          reasoning: result.data.reasoning,
          risk: result.data.risk,
        }

        logEvent('limkenion_permission_explainer_generated', {
          tool_name: sanitizeToolNameForAnalytics(toolName),
          risk_level: RISK_LEVEL_NUMERIC[explanation.riskLevel],
          latency_ms: latencyMs,
        })
        logForDebugging(
          `权限解释器：${toolName} 风险等级 ${explanation.riskLevel}（${latencyMs}ms）`,
        )
        return explanation
      }
    }

    // 响应中没有有效的 JSON
    logEvent('limkenion_permission_explainer_error', {
      tool_name: sanitizeToolNameForAnalytics(toolName),
      error_type: ERROR_TYPE_PARSE,
      latency_ms: latencyMs,
    })
    logForDebugging(`权限解释器：响应中无法解析出输出`)
    return null
  } catch (error) {
    const latencyMs = Date.now() - startTime

    // 中止的请求不作为错误记录
    if (signal.aborted) {
      logForDebugging(`权限解释器：针对 ${toolName} 的请求已中止`)
      return null
    }

    logForDebugging(`权限解释器错误：${errorMessage(error)}`)
    logError(error)
    logEvent('limkenion_permission_explainer_error', {
      tool_name: sanitizeToolNameForAnalytics(toolName),
      error_type:
        error instanceof Error && error.name === 'AbortError'
          ? ERROR_TYPE_NETWORK
          : ERROR_TYPE_UNKNOWN,
      latency_ms: latencyMs,
    })
    return null
  }
}
