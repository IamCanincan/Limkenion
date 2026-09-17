import { feature } from 'bun:bundle'
import type Limkenion from '../../types/llm-protocol.js'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '../../types/llm-protocol.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getLimkenionAIOAuthTokens,
  handleOAuth401Error,
  isLimkenionAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomStrongModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// 前台查询来源：用户在等待其结果的调用 —— 这些在 529 时会重试。
// 其余一切（摘要、标题、建议、分类器）立即放弃：在容量级联时，
// 每次重试都会造成 3-10 倍的网关放大，而且用户反正也看不到它们失败。
// 新来源默认不重试 —— 仅当用户确实在等结果时才加入这里。
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // 安全分类器 —— 必须完成以确保自动模式正确性。
  // yoloClassifier.ts 使用 'auto_mode'（而非 'yolo_classifier'，那只是类型）。
  // bash_classifier 仅 Ant；做特性门控，让该字符串从外部构建中被树摇掉
  //（excluded-strings.txt）。
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → 重试（对未打标签的调用路径保持保守）
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// LIMKENION_UNATTENDED_RETRY: 用于无人值守会话（仅 Ant）。以更高的退避
// 无期限地重试 429/529，并周期性让出 keep-alive，使宿主环境不会在等待期间
// 将会话标记为空闲。
// TODO(ANT-344): 在提供专门的 keep-alive 通道之前，通过 SystemAPIErrorMessage
// 让出作为临时过渡方案。
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.LIMKENION_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * 预置连续 529 计数值。当本重试循环是流式 529 之后的无流式回退时使用 ——
   * 那个流式 529 应计入 MAX_529_RETRIES，这样无论哪个请求模式命中了过载，
   * 回退前的总 529 次数都保持一致。
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // 保留可用的原始堆栈跟踪
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Limkenion>,
  operation: (
    client: Limkenion,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Limkenion | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // 本次尝试前记录 fast 模式是否激活
    //（回退可能在此循环中改变状态）
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // 检查 mock 限流（/mock-limits 命令供 Ant 员工使用）
      

      // 在首次尝试或认证错误之后获取新的客户端实例
      // - 401：一流的 API 认证失败
      // - 403 "OAuth token has been revoked"（另一进程刷新了 token）
      // - Bedrock 特定认证错误（403 或 CredentialsProviderError）
      // - Vertex 特定认证错误（凭据刷新失败、401）
      // - ECONNRESET/EPIPE：过期 keep-alive 套接字；禁用连接池并重连
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'limkenion_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          '过期连接（ECONNRESET/EPIPE）—— 为重试禁用 keep-alive',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        // 对 401 "token 过期" 或 403 "token 被撤销"，强制刷新 token
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getLimkenionAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Fast 模式回退：遇到 429/529 时，要么短延迟等待后重试，
      // 要么回退到标准速度（长延迟）以避免缓存抖动。
      // 无人值守模式跳过：下面的短重试路径仍以 fast 模式循环，
      // 因此它的 continue 永远不会触及尝试次数钳制，for 循环会终结。
      // 无人值守会话本就想要分块 keep-alive 路径而非 fast 模式缓存保留。
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // 若 429 专因额外用量（overage）不可用，则用特定消息永久禁用 fast 模式。
        const overageReason = error.headers?.get(
          'limkenion-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // 短重试时间：等待后仍以 fast 模式重试，
          // 以保留 prompt 缓存（重试时保持同一模型名）。
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // 长或未知重试时间：进入冷却（切到标准速度模型），
        // 并设置最小下限以避免反复切换。
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast 模式回退：若 API 拒绝 fast 模式参数
      //（例如组织未启用 fast 模式），则永久禁用 fast 模式并按标准速度重试。
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // 非前台来源遇到 529 立即放弃 —— 容量级联时不做重试放大。
      // 用户不会看到这些失败。
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('limkenion_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // 追踪连续 529 错误
      if (
        is529Error(error) &&
        // 若未设置 FALLBACK_FOR_ALL_PRIMARY_MODELS，则仅在主模型为非自定义 deepseek-v4-pro 模型时继续。
        // TODO: 重新审视 isNonCustomStrongModel 检查是否仍应存在，或者说
        // isNonCustomStrongModel 是否只是 Limkenion 曾硬编码在 deepseek-v4-pro 上时的过时产物。
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isLimkenionAISubscriber() && isNonCustomStrongModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // 检查是否指定了回退模型
          if (options.fallbackModel) {
            logEvent('limkenion_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // 抛出特殊错误以指示已触发回退
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          
        }
      }

      // 仅在错误表明应重试时才重试
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP 错误不总是 APIError，但可以重试
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // 通过为下一次尝试调整 max_tokens 来处理上下文溢出错误
      // 注意：在 extended-context-window beta 下，不应再出现这个 400 错误。
      // API 现在改为返回 'model_context_window_exceeded' stop_reason。
      // 保留它以兼容旧版本。
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `可用上下文 ${availableContext} 小于 FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // 确保为思考留出足够 token，且至少 1 个输出 token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('limkenion_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // 对于其他错误，按正常重试逻辑处理
      // 若可用则获取 retry-after 响应头
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // 基于窗口的限制（例如 5 小时 Max/Pro）包含重置时间戳。
        // 等到重置，而不是无意义地每 5 分钟轮询一次。
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After 是服务端指令，绕过 getRetryDelay 内部的
        // maxDelayMs（有意为之 —— 遵守它是正确的）。在此处以 6 小时重置上限
        // 为封顶，以免病态状态头导致无限等待。
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // 在无人值守模式下，for 循环的 `attempt` 会被钳制在 maxRetries+1；
      // 对遥测/让出使用 persistentAttempt，以显示真实计数。
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('limkenion_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('limkenion_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // 将长休眠分块，使宿主看到周期性的 stdout 活动，不会将会话
        // 标记为空闲。每次让出都会通过 QueryEngine 以
        // {type:'system', subtype:'api_retry'} 形式出现在 stdout 上。
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // 钳制以终结 for 循环。退避使用单独的 persistentAttempt 计数器，
        // 它会持续增长到 5 分钟上限。
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // 示例格式: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        '无法从上下文超限错误信息中解析出 max_tokens',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: 等 API 增加专门的 fast 模式拒绝响应头（例如 x-fast-mode-rejected）
// 后再改用响应头检查。对错误信息做字符串匹配较为脆弱，
// 一旦 API 措辞改变就会失效。
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // 检查 529 状态码或消息中的 overloaded 错误
  return (
    error.status === 529 ||
    // 参见下文：流式传输时 SDK 有时无法正确地传递 529 状态码
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.LIMKENION_USE_BEDROCK)) {
    // AWS 库在 .aws 里持有过期的 Expiration 值时会在不发 API 调用的情况下拒绝，
    // 否则收到过期 token 的 API 调用会给出通用的 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * 若合适则清除 AWS 认证缓存。
 * @returns 若已采取行动则返回 true。
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library 抛出普通 Error（没有 AWS CredentialsProviderError
// 那样的类型化名字）。匹配常见的 SDK 级凭据失败消息。
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.LIMKENION_USE_VERTEX)) {
    // SDK 级：google-auth-library 在 HTTP 调用前的 prepareOptions() 中失败
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // 服务端：Vertex 对过期/无效 token 返回 401
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * 若合适则清除 GCP 认证缓存。
 * @returns 若已采取行动则返回 true。
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

function shouldRetry(error: APIError): boolean {
  // 永不重试 mock 错误 —— 它们来自 /mock-limits 命令用于测试。
  if (isMockRateLimitError(error)) {
    return false
  }

  // 无人值守模式：429/529 总是可重试，绕过订阅门禁与 x-should-retry 响应头。
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR 模式：认证走基础设施提供的 JWT，因此 401/403 是偶发抖动
  //（认证服务波动、网络打嗝），而非凭据错误。绕过 x-should-retry:false ——
  // 服务器假设我们会重试同一个坏 key，但我们的 key 是没问题的。
  if (
    isEnvTruthy(process.env.LIMKENION_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // 先通过检查消息内容来判断是否过载。
  // 流式传输时 SDK 有时无法正确地传递 529 状态码，
  // 因此需要直接检查错误消息。
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // 检查可处理的 max tokens 上下文溢出错误
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // 注意：这不是标准响应头。
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // 若服务端明确说明了是否重试，就遵守它。
  // 对 Max 和 Pro 用户，should-retry 为 true，但在数小时之后，因此我们不应该重试。
  // 企业用户通常使用按量付费而非限流，因此可以重试。
  if (
    shouldRetryHeader === 'true' &&
    (!isLimkenionAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // Ant 们仅对 5xx 服务器错误可以忽略 x-should-retry: false。
  // 对其他状态码（401、403、400、429 等），遵守响应头。
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(false)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // 请求超时时重试。
  if (error.status === 408) return true

  // 锁超时时重试。
  if (error.status === 409) return true

  // 命中的限流时重试，但 LimkenionAI 订阅用户除外。
  // 企业用户通常使用按量付费而非限流，因此可以重试。
  if (error.status === 429) {
    return !isLimkenionAISubscriber() || isEnterpriseSubscriber()
  }

  // 在 401 时清除 API key 缓存并允许重试。
  // OAuth token 处理由主重试循环中的 handleOAuth401Error 完成。
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // 403 "token 被撤销" 时重试（与 401 相同的刷新逻辑，见上文）
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // 内部错误时重试。
  if (error.status && error.status >= 500) return true

  return false
}

export function getDefaultMaxRetries(): number {
  if (process.env.LIMKENION_MAX_RETRIES) {
    return parseInt(process.env.LIMKENION_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('limkenion-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
