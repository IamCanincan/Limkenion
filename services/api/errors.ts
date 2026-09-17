import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '../../types/llm-protocol.js'
import type {
  BetaMessage,
  BetaStopReason,
} from '../../types/llm-protocol.js'
import { AFK_MODE_BETA_HEADER } from 'src/constants/betas.js'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import {
  getLimkenionApiKeyWithSource,
  getLimkenionAIOAuthTokens,
  isLimkenionAISubscriber,
} from 'src/utils/auth.js'
import {
  createAssistantAPIErrorMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/utils/messages.js'
import {
  getDefaultMainLoopModelSetting,
  isNonCustomStrongModel,
} from 'src/utils/model/model.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  API_PDF_MAX_PAGES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatFileSize } from '../../utils/format.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type LimkenionAILimits,
  getRateLimitErrorMessage,
  type OverageDisabledReason,
} from '../limkenionAiLimits.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js' // 用于 /mock-limits 命令
import { extractConnectionErrorDetails, formatAPIError } from './errorUtils.js'

export const API_ERROR_MESSAGE_PREFIX = 'API Error'

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Please run /login · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  if (!msg.isApiErrorMessage) {
    return false
  }
  const content = msg.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      block.type === 'text' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * 从原始的 prompt 过长 API 错误信息（如 "prompt is too long: 137500 tokens > 135000 maximum"）
 * 中解析出实际/上限 token 数量。原始字符串可能包裹在 SDK 前缀或 JSON 信封里，
 * 或大小写不同（Vertex），因此这里做了刻意放宽容忍。
 */
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

/**
 * 返回 prompt 过长错误报告的超限 token 数量，若信息不是 PTL 或 errorDetails 无法解析则返回 undefined。
 * 响应式压缩用它来在一次重试中跳过多个分组，而不是逐次逐个剥离。
 */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) {
    return undefined
  }
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    msg.errorDetails,
  )
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined
  }
  const gap = actualTokens - limitTokens
  return gap > 0 ? gap : undefined
}

/**
 * 判断这条原始 API 错误文本是否为媒体尺寸被拒错误（stripImagesFromMessages 可修复）。
 * 响应式压缩的 summarize 重试用它来决定是否剥离后重试（媒体错误），否则直接放弃（其它情况）。
 *
 * 这些模式必须与填充 errorDetails 的 getAssistantMessageFromError 分支（~L523 PDF、~L560 图片、
 * ~L573 多图）以及 classifyAPIError 分支（~L929-946）保持同步。闭环：errorDetails
 * 只会在这些分支已经匹配到同样子串之后才会被写入，因此对这条路径来说
 * isMediaSizeError(errorDetails) 恒为真。API 措辞漂移只会导致优雅降级
 * （errorDetails 保持 undefined、调用方短路），不会产生假阴性。
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes('image exceeds') && raw.includes('maximum')) ||
    (raw.includes('image dimensions exceed') && raw.includes('many-image')) ||
    /maximum of \d+ PDF pages/.test(raw)
  )
}

/**
 * 消息级谓词：这条助手消息是否为媒体尺寸被拒错误？
 * 与 isPromptTooLongMessage 平行。它检查 errorDetails（由 ~L523/560/573 处的
 * getAssistantMessageFromError 分支填充的原始 API 错误字符串）而不是内容文本，
 * 因为媒体错误针对不同变体有不同的内容字符串。
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean {
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails)
  )
}
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE =
  'API Key 无效 · 请检查 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量，然后重启 Limkenion'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  '无效的 API key · 请修复外部 API key'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH =
  '你的 LIMKENION_API_KEY 属于一个已被禁用的组织 · 取消设置该环境变量以改用你的订阅'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  '你的 LIMKENION_API_KEY 属于一个已被禁用的组织 · 请更新或取消设置该环境变量'
export const TOKEN_REVOKED_ERROR_MESSAGE =
  'OAuth token 已被撤销 · 请运行 /login'
export const CCR_AUTH_ERROR_MESSAGE =
  '认证出错 · 这可能是临时的网络问题，请重试'
export const REPEATED_529_ERROR_MESSAGE = 'Repeated 529 Overloaded errors'
export const CUSTOM_OFF_SWITCH_MESSAGE =
  'DeepSeek V4 Pro 当前负载较高，可用 /model 切到 DeepSeek Flash'
export const API_TIMEOUT_ERROR_MESSAGE = '请求超时'
export function getPdfTooLargeErrorMessage(): string {
  const limits = `max ${API_PDF_MAX_PAGES} pages, ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `PDF 过大（${limits}）。请尝试换一种方式读取文件（例如用 pdftotext 提取文本）。`
    : `PDF 过大（${limits}）。请双击 esc 返回并重试，或使用 pdftotext 先转换为文本。`
}
export function getPdfPasswordProtectedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'PDF 受密码保护。请尝试使用 CLI 工具提取或转换该 PDF。'
    : 'PDF 受密码保护。请双击 esc 修改你的消息后重试。'
}
export function getPdfInvalidErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '该 PDF 文件无效。请先尝试将其转换为文本（例如 pdftotext）。'
    : '该 PDF 文件无效。请双击 esc 返回并用其他文件重试。'
}
export function getImageTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '图片过大。请尝试调整图片大小或换一种方式。'
    : '图片过大。请双击 esc 返回并用更小的图片重试。'
}
export function getRequestTooLargeErrorMessage(): string {
  const limits = `max ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `请求过大（${limits}）。请尝试使用更小的文件。`
    : `请求过大（${limits}）。请双击 esc 返回并尝试更小的文件。`
}
export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  '你的账号没有权限使用 Limkenion。请运行 /login。'

export function getTokenRevokedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '你的账号没有权限使用 Limkenion，请重新登录或联系管理员。'
    : TOKEN_REVOKED_ERROR_MESSAGE
}

export function getOauthOrgNotAllowedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '你的组织没有权限使用 Limkenion，请重新登录或联系管理员。'
    : OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE
}

/**
 * 判断是否处于 CCR（Limkenion Remote）模式。
 * 在 CCR 模式下，认证由基础设施提供的 JWT 处理，而非 /login。
 * 偶发的认证错误应建议重试，而不是去登录。
 */
function isCCRMode(): boolean {
  return isEnvTruthy(process.env.LIMKENION_REMOTE)
}

// 临时辅助：记录 tool_use/tool_result 不匹配错误
function logToolUseToolResultMismatch(
  toolUseId: string,
  messages: Message[],
  messagesForAPI: (UserMessage | AssistantMessage)[],
): void {
  try {
    // 在规范化消息中查找 tool_use
    let normalizedIndex = -1
    for (let i = 0; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            'id' in block &&
            block.id === toolUseId
          ) {
            normalizedIndex = i
            break
          }
        }
      }
      if (normalizedIndex !== -1) break
    }

    // 在原始消息中查找 tool_use
    let originalIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (msg.type === 'assistant' && 'message' in msg) {
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              block.id === toolUseId
            ) {
              originalIndex = i
              break
            }
          }
        }
      }
      if (originalIndex !== -1) break
    }

    // 构建规范化序列
    const normalizedSeq: string[] = []
    for (let i = normalizedIndex + 1; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const role = msg.message.role
          if (block.type === 'tool_use' && 'id' in block) {
            normalizedSeq.push(`${role}:tool_use:${block.id}`)
          } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
            normalizedSeq.push(`${role}:tool_result:${block.tool_use_id}`)
          } else if (block.type === 'text') {
            normalizedSeq.push(`${role}:text`)
          } else if (block.type === 'thinking') {
            normalizedSeq.push(`${role}:thinking`)
          } else if (block.type === 'image') {
            normalizedSeq.push(`${role}:image`)
          } else {
            normalizedSeq.push(`${role}:${block.type}`)
          }
        }
      } else if (typeof content === 'string') {
        normalizedSeq.push(`${msg.message.role}:string_content`)
      }
    }

    // 构建规范化前的序列
    const preNormalizedSeq: string[] = []
    for (let i = originalIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue

      switch (msg.type) {
        case 'user':
        case 'assistant': {
          if ('message' in msg) {
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const role = msg.message.role
                if (block.type === 'tool_use' && 'id' in block) {
                  preNormalizedSeq.push(`${role}:tool_use:${block.id}`)
                } else if (
                  block.type === 'tool_result' &&
                  'tool_use_id' in block
                ) {
                  preNormalizedSeq.push(
                    `${role}:tool_result:${block.tool_use_id}`,
                  )
                } else if (block.type === 'text') {
                  preNormalizedSeq.push(`${role}:text`)
                } else if (block.type === 'thinking') {
                  preNormalizedSeq.push(`${role}:thinking`)
                } else if (block.type === 'image') {
                  preNormalizedSeq.push(`${role}:image`)
                } else {
                  preNormalizedSeq.push(`${role}:${block.type}`)
                }
              }
            } else if (typeof content === 'string') {
              preNormalizedSeq.push(`${msg.message.role}:string_content`)
            }
          }
          break
        }
        case 'attachment':
          if ('attachment' in msg) {
            preNormalizedSeq.push(`attachment:${msg.attachment.type}`)
          }
          break
        case 'system':
          if ('subtype' in msg) {
            preNormalizedSeq.push(`system:${msg.subtype}`)
          }
          break
        case 'progress':
          if (
            'progress' in msg &&
            msg.progress &&
            typeof msg.progress === 'object' &&
            'type' in msg.progress
          ) {
            preNormalizedSeq.push(`progress:${msg.progress.type ?? 'unknown'}`)
          } else {
            preNormalizedSeq.push('progress:unknown')
          }
          break
      }
    }

    // 记录到 Statsig
    logEvent('limkenion_tool_use_tool_result_mismatch_error', {
      toolUseId:
        toolUseId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedSequence: normalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      preNormalizedSequence: preNormalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedMessageCount: messagesForAPI.length,
      originalMessageCount: messages.length,
      normalizedToolUseIndex: normalizedIndex,
      originalToolUseIndex: originalIndex,
    })
  } catch (_) {
    // 忽略调试日志中的错误
  }
}

/**
 * 类型守卫：判断某个值是否是 API 返回的合法 Message 响应
 */
export function isValidAPIMessage(value: unknown): value is BetaMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'model' in value &&
    'usage' in value &&
    Array.isArray((value as BetaMessage).content) &&
    typeof (value as BetaMessage).model === 'string' &&
    typeof (value as BetaMessage).usage === 'object'
  )
}

/** AWS 可能返回的底层错误。 */
type AmazonError = {
  Output?: {
    __type?: string
  }
  Version?: string
}

/**
 * 给定一个看起来不太对劲的响应，尝试从中提取已知的错误类型。
 */
export function extractUnknownErrorFormat(value: unknown): string | undefined {
  // 先判断 value 是否是合法对象
  if (!value || typeof value !== 'object') {
    return undefined
  }

  // Amazon Bedrock 路由错误
  if ((value as AmazonError).Output?.__type) {
    return (value as AmazonError).Output!.__type
  }

  return undefined
}

export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  },
): AssistantMessage {
  // 检查 SDK 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return createAssistantAPIErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'unknown',
    })
  }

  // 检查图片大小/缩放错误（在 API 调用前的校验阶段抛出）
  // 使用 getImageTooLargeErrorMessage() 为 CLI 用户显示“esc esc”提示，
  // 而对 SDK 用户（非交互模式）显示通用信息。
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
    })
  }

  // 检查 deepseek-v4-pro 按量付费用户的紧急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

  if (
    error instanceof APIError &&
    error.status === 429 &&
    shouldProcessRateLimits(isLimkenionAISubscriber())
  ) {
    // 检查这是否是带多重限流响应头的新 API
    const rateLimitType = error.headers?.get?.(
      'limkenion-ratelimit-unified-representative-claim',
    ) as 'five_hour' | 'seven_day' | null

    const overageStatus = error.headers?.get?.(
      'limkenion-ratelimit-unified-overage-status',
    ) as 'allowed' | 'allowed_warning' | 'rejected' | null

    // 如果包含新响应头，使用新的消息生成逻辑
    if (rateLimitType || overageStatus) {
      // 根据错误响应头构建 limits 对象，以确定合适的消息
      const limits: LimkenionAILimits = {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }

      // 从响应头中提取限流信息
      const resetHeader = error.headers?.get?.(
        'limkenion-ratelimit-unified-reset',
      )
      if (resetHeader) {
        limits.resetsAt = Number(resetHeader)
      }

      if (rateLimitType) {
        limits.rateLimitType = rateLimitType
      }

      if (overageStatus) {
        limits.overageStatus = overageStatus
      }

      const overageResetHeader = error.headers?.get?.(
        'limkenion-ratelimit-unified-overage-reset',
      )
      if (overageResetHeader) {
        limits.overageResetsAt = Number(overageResetHeader)
      }

      const overageDisabledReason = error.headers?.get?.(
        'limkenion-ratelimit-unified-overage-disabled-reason',
      ) as OverageDisabledReason | null
      if (overageDisabledReason) {
        limits.overageDisabledReason = overageDisabledReason
      }

      // 为所有新版 API 限流使用新的消息格式
      const specificErrorMessage = getRateLimitErrorMessage(limits, model)
      if (specificErrorMessage) {
        return createAssistantAPIErrorMessage({
          content: specificErrorMessage,
          error: 'rate_limit',
        })
      }

      // 若 getRateLimitErrorMessage 返回 null，说明该回退机制会静默处理此情况
      // （例如符合条件用户的 deepseek-v4-pro -> deepseek-flash 回退）。
      // 返回 NO_RESPONSE_REQUESTED，这样不向用户展示错误，但该消息仍会
      // 记录在对话历史中供 Limkenion 查看。
      return createAssistantAPIErrorMessage({
        content: NO_RESPONSE_REQUESTED,
        error: 'rate_limit',
      })
    }

    // 没有配额响应头 —— 这不是配额限制。展示 API 实际返回的内容，
    // 而不是笼统的“已触发限流”。授权拒绝（例如没有 Extra Usage 的情况下使用 1M 上下文）
    // 以及基础设施容量 429 都会落在这里。
    if (error.message.includes('Extra usage is required for long context')) {
      const hint = getIsNonInteractiveSession()
        ? '启用 extra usage，或使用 --model 切换到标准上下文'
        : '运行 /extra-usage 开启，或使用 /model 切换到标准上下文'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: 使用 1M 上下文需要 Extra usage · ${hint}`,
        error: 'rate_limit',
      })
    }
    // SDK 的 APIError.makeMessage 会前置 "429 " 并在没有顶层 .message 时
    // JSON 序列化 response 体 —— 提取内层 error.message。
    const stripped = error.message.replace(/^429\s+/, '')
    const innerMessage = stripped.match(/"message"\s*:\s*"([^"]*)"/)?.[1]
    const detail = innerMessage || stripped
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: 请求被拒绝（429）· ${detail || '这可能是临时性的容量问题，请稍后重试'}`,
      error: 'rate_limit',
    })
  }

  // 处理 prompt 过长错误（Vertex 返回 413，直接 API 返回 400）
  // 使用大小写不敏感检查，因为 Vertex 返回 "Prompt is too long"（大写）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('prompt is too long')
  ) {
    // Content 保持通用（界面按精确字符串匹配）。带 token 计数的原始错误
    // 放入 errorDetails —— 响应式压缩的重试循环通过 getPromptTooLongTokenGap
    // 从这里解析出差距。
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查 PDF 页数超限错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查受密码保护的 PDF 错误
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查无效 PDF 错误（例如把 HTML 文件改名成 .pdf）
  // 若不处理，无效的 PDF 文档块会一直留在对话上下文里，
  // 导致之后的每次 API 调用都以 400 失败。
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified was not valid')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查图片大小错误（例如 "image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: error.message,
    })
  }

  // 检查多图尺寸错误（API 对多图请求执行更严格的 2000px 限制）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return createAssistantAPIErrorMessage({
      content: getIsNonInteractiveSession()
        ? '对话中的图片超出了多图请求的尺寸限制（2000px）。请开启新的会话并使用更少的图片。'
        : '对话中的图片超出了多图请求的尺寸限制（2000px）。请运行 /compact 移除上下文中的旧图片，或开启新的会话。',
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 服务端拒绝了 afk-mode beta 响应头（套餐不包含自动模式）。
  // AFK_MODE_BETA_HEADER 在非 TRANSCRIPT_CLASSIFIER 构建中为 ''，
  // 因此这里用真值判断让它在该构建中保持惰性。
  if (
    AFK_MODE_BETA_HEADER &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(AFK_MODE_BETA_HEADER) &&
    error.message.includes('limkenion-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: '你的套餐不支持自动模式',
      error: 'invalid_request',
    })
  }

  // 检查请求过大错误（413 状态）
  // 通常发生在大 PDF 加对话上下文超过 32MB API 限制时
  if (error instanceof APIError && error.status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查 tool_use/tool_result 并发错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    // 若拥有消息上下文则记录到 Statsig
    if (options?.messages && options?.messagesForAPI) {
      const toolUseIdMatch = error.message.match(/toolu_[a-zA-Z0-9]+/)
      const toolUseId = toolUseIdMatch ? toolUseIdMatch[0] : null
      if (toolUseId) {
        logToolUseToolResultMismatch(
          toolUseId,
          options.messages,
          options.messagesForAPI,
        )
      }
    }

     {
      const baseMessage = 'API 错误：400 由工具使用并发冲突导致。'
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' 运行 /rewind 可恢复对话。'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    }
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    logEvent('limkenion_unexpected_tool_result', {})
  }

  // 重复的 tool_use ID（CC-1212）。ensureToolResultPairing 在发送前会剥离它们，
  // 所以命中此分支意味着有新的损坏路径漏了进来。
  // 记录日志以定位根因，并给用户一条恢复路径而非死锁。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    logEvent('limkenion_duplicate_tool_use_id', {})
    const rewindInstruction = getIsNonInteractiveSession()
      ? ''
      : ' 运行 /rewind 可恢复对话。'
    return createAssistantAPIErrorMessage({
      content: `API 错误：400 对话历史中出现重复的 tool_use ID。${rewindInstruction}`,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查订阅用户尝试使用 deepseek-v4-pro 时的无效模型名错误
  if (
    isLimkenionAISubscriber() &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name') &&
    isNonCustomStrongModel(model)
  ) {
    return createAssistantAPIErrorMessage({
      content:
        '该模型当前不可用。本地 DeepSeek 模式下请检查 DEEPSEEK_API_KEY / OPENAI_API_KEY 配置。',
      error: 'invalid_request',
    })
  }

  // 为 Ant 用户检查无效模型名错误。Limkenion 可能正为 Ants
  // 默认指向一个仅内部使用的自定义模型，也可能存在使用尚未被
  // 纳入门禁的新或未知组织 ID 的 Ants。
  

  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
    })
  }
  // "Organization has been disabled" —— 通常是上一个雇主/项目遗留的过期
  // LIMKENION_API_KEY 覆盖了订阅认证所致。这里只处理环境变量的情况；
  // apiKeyHelper 和 /login 管理的 key 意味着当前认证所属组织确实被禁用，
  // 没有可指向的休眠回退方案。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('organization has been disabled')
  ) {
    const { source } = getLimkenionApiKeyWithSource()
    // getLimkenionApiKeyWithSource 会把环境变量与通过 FD 传入的 key 归入同一
    // source 值，且在 CCR 模式下 OAuth 在环境变量存在时仍然保持生效。
    // 这三个守卫确保我们只在环境变量确实设置且确实在链路上时才归咎于它。
    if (
      source === 'LIMKENION_API_KEY' &&
      process.env.LIMKENION_API_KEY &&
      !isLimkenionAISubscriber()
    ) {
      const hasStoredOAuth = getLimkenionAIOAuthTokens()?.accessToken != null
      // 不使用 'authentication_failed' —— 那会触发 VS Code 的 showLogin()，但
      // 登录无法修复此问题（已批准的环境变量会持续覆盖 OAuth）。这里的修复
      // 属于配置层面（取消设置该变量），因此使用 invalid_request 是正确的。
      return createAssistantAPIErrorMessage({
        error: 'invalid_request',
        content: hasStoredOAuth
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
      })
    }
  }

  // OpenAI 兼容模式（DeepSeek / 任意 OpenAI 格式端点）的认证失败。
  // 这条路径不经过 上游 SDK，抛的是 OpenAI SDK 的错误，message 形如
  // "Authentication Fails, Your api key: ****xxxx is invalid"，
  // 既不含 'x-api-key' 也不是本模块的 APIError，所以单独认一次。
  if (
    error instanceof Error &&
    /authentication fails|invalid[_\s-]?api[_\s-]?key/i.test(error.message)
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    // 在 CCR 模式下，认证走 JWT —— 这可能是偶发的网络问题
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    // 检查 API key 是否来自外部来源
    const { source } = getLimkenionApiKeyWithSource()
    const isExternalSource =
      source === 'LIMKENION_API_KEY' || source === 'apiKeyHelper'

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: isExternalSource
        ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
        : INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

  // 检查 OAuth token 撤销错误
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getTokenRevokedErrorMessage(),
    })
  }

  // 检查 OAuth 组织不被允许错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getOauthOrgNotAllowedErrorMessage(),
    })
  }

  // 其他 401/403 认证错误的通用处理
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    // 在 CCR 模式下，认证走 JWT —— 这可能是偶发的网络问题
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getIsNonInteractiveSession()
        ? `认证失败。${API_ERROR_MESSAGE_PREFIX}: ${error.message}`
        : `请运行 /login · ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    })
  }

  // Bedrock 错误，比如 "403 You don't have access to the model with the specified model ID."
  // 不包含实际的模型 ID
  if (
    isEnvTruthy(process.env.LIMKENION_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}。尝试运行 ${switchCmd} 切换到 ${fallbackSuggestion}。`
        : `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}。运行 ${switchCmd} 选择其他模型。`,
      error: 'invalid_request',
    })
  }

  // 404 Not Found —— 通常意味着所选模型不存在或不可用。
  // 引导用户使用 /model 以便挑选一个有效的模型。
  // 对 3P 用户，建议一个可尝试的特定回退模型。
  if (error instanceof APIError && error.status === 404) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `模型 ${model} 在你的 ${getAPIProvider()} 部署上不可用。尝试运行 ${switchCmd} 切换到 ${fallbackSuggestion}，或联系管理员启用该模型。`
        : `所选模型（${model}）存在问题，它可能不存在或你没有使用权。运行 ${switchCmd} 选择其他模型。`,
      error: 'invalid_request',
    })
  }

  // 连接错误（非超时）—— 使用 formatAPIError 获取详细信息
  if (error instanceof APIConnectionError) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatAPIError(error)}`,
      error: 'unknown',
    })
  }

  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
    })
  }
  return createAssistantAPIErrorMessage({
    content: API_ERROR_MESSAGE_PREFIX,
    error: 'unknown',
  })
}

/**
 * 对 3P 用户，当所选模型不可用时建议一个回退模型。
 * 返回模型名建议，若无适用建议则返回 undefined。
 */
function get3PModelFallbackSuggestion(_model: string): string | undefined {
  // 本构建只有 firstParty（DeepSeek），原本那套"按上游模型名建议回退版本"的
  // 分支链在 firstParty 下本来就恒返回 undefined，已随模型表移除。
  return undefined
}

/**
 * 将 API 错误归类为特定错误类型，用于分析追踪。
 * 返回适合 Datadog 打标签的标准错误类型字符串。
 */
export function classifyAPIError(error: unknown): string {
  // 中止的请求
  if (error instanceof Error && error.message === 'Request was aborted.') {
    return 'aborted'
  }

  // 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return 'api_timeout'
  }

  // 检查重复的 529 错误
  if (
    error instanceof Error &&
    error.message.includes(REPEATED_529_ERROR_MESSAGE)
  ) {
    return 'repeated_529'
  }

  // 检查紧急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return 'capacity_off_switch'
  }

  // 限流
  if (error instanceof APIError && error.status === 429) {
    return 'rate_limit'
  }

  // 服务器过载（529）
  if (
    error instanceof APIError &&
    (error.status === 529 ||
      error.message?.includes('"type":"overloaded_error"'))
  ) {
    return 'server_overload'
  }

  // Prompt/内容大小错误
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'prompt_too_long'
  }

  // PDF 错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return 'pdf_too_large'
  }

  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return 'pdf_password_protected'
  }

  // 图片大小错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return 'image_too_large'
  }

  // 多图尺寸错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return 'image_too_large'
  }

  // 工具使用错误（400）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    return 'tool_use_mismatch'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    return 'unexpected_tool_result'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    return 'duplicate_tool_use_id'
  }

  // 无效模型错误（400）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name')
  ) {
    return 'invalid_model'
  }

  // 信用/账单错误
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'credit_balance_low'
  }

  // 认证错误
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return 'invalid_api_key'
  }

  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return 'token_revoked'
  }

  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return 'oauth_org_not_allowed'
  }

  // 通用认证错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    return 'auth_error'
  }

  // Bedrock 特定错误
  if (
    isEnvTruthy(process.env.LIMKENION_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    return 'bedrock_model_access'
  }

  // 基于状态码的回退
  if (error instanceof APIError) {
    const status = error.status
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }

  // 连接错误 —— 先检查 SSL/TLS 问题
  if (error instanceof APIConnectionError) {
    const connectionDetails = extractConnectionErrorDetails(error)
    if (connectionDetails?.isSSLError) {
      return 'ssl_cert_error'
    }
    return 'connection_error'
  }

  return 'unknown'
}

export function categorizeRetryableAPIError(
  error: APIError,
): SDKAssistantMessageError {
  if (
    error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return 'rate_limit'
  }
  if (error.status === 429) {
    return 'rate_limit'
  }
  if (error.status === 401 || error.status === 403) {
    return 'authentication_failed'
  }
  if (error.status !== undefined && error.status >= 408) {
    return 'server_error'
  }
  return 'unknown'
}

export function getErrorMessageIfRefusal(
  stopReason: BetaStopReason | null,
  model: string,
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') {
    return
  }

  logEvent('limkenion_refusal_api_response', {})

  const baseMessage = getIsNonInteractiveSession()
    ? `${API_ERROR_MESSAGE_PREFIX}: Limkenion 无法响应该请求，它似乎违反了我们的使用政策。请尝试改写请求或换一种方式。`
    : `${API_ERROR_MESSAGE_PREFIX}: Limkenion 无法响应该请求，它似乎违反了我们的使用政策。请双击 esc 修改你的上一条消息，或开启新的会话让 Limkenion 帮你处理其他任务。`

  const modelSuggestion =
    model !== 'deepseek-flash'
      ? ' 如果你反复遇到此拒绝，请尝试运行 /model deepseek-flash 切换模型。'
      : ''

  return createAssistantAPIErrorMessage({
    content: baseMessage + modelSuggestion,
    error: 'invalid_request',
  })
}
