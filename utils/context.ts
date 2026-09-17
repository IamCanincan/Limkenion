// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'

// 模型上下文窗口大小。
// DeepSeek 官方给出的是 **1M**（https://api-docs.deepseek.com/quick_start/pricing），
// 原本这里是上游的 200k —— 那会让长对话被过早触发自动压缩。
export const MODEL_CONTEXT_WINDOW_DEFAULT = 1_000_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// 单次请求的默认输出上限（策略值，保守控制成本）
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
// 模型能输出的上限。DeepSeek 官方给出的是 **384K**，原本这里写的是上游的 64K。
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 384_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// limkenion.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.LIMKENION_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  // DeepSeek 两个模型的上下文本来就是 1M。
  return canonical.includes('deepseek-')
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (ant-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (get1mContextTreatmentEnabled(model)) {
    return 1_000_000
  }
  
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * 1M 上下文的实验开关。
 *
 * **本构建恒返回 false** —— 原本它依赖服务端下发的 `clientDataCache` 标记，
 * 而本构建没有服务端，那个缓存永远不会被写入；而且 DeepSeek 的上下文本来就是 1M，
 * 不需要这种实验性开关。
 */
export function get1mContextTreatmentEnabled(_model: string): boolean {
  return false
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 *
 * 本构建只有 DeepSeek。官方给出最大输出 384K
 * （https://api-docs.deepseek.com/quick_start/pricing），
 * 但这里沿用保守的通用上限 —— 放开到 384K 属于行为变更，另行确认。
 *
 * 原本那一长串按上游模型名分档的判断（deepseek-v4-pro-4-6 / deepseek-flash-4-6 / deepseek-flash-4 /
 * limkenion-3-* …）已随模型表一起删除。
 */
export function getModelMaxOutputTokens(_model: string): {
  default: number
  upperLimit: number
} {
  return {
    default: MAX_OUTPUT_TOKENS_DEFAULT,
    upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
