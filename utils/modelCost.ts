import type { BetaUsage as Usage } from '../types/llm-protocol.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import {
  DEEPSEEK_FLASH_CONFIG,
  DEEPSEEK_V4_PRO_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.limkenion.com/docs/en/about-limkenion/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

/**
 * DeepSeek 官方定价（USD / 1M tokens），取**峰时**价作为保守上界。
 * 峰时为 UTC 周一至周五 01:00-04:00 与 06:00-10:00，其余时段为半价。
 * 来源：https://api-docs.deepseek.com/quick_start/pricing （2026-09-17 核对）
 *
 * DeepSeek 的前缀缓存是**自动**的、不额外收取写入费用，所以
 * promptCacheWriteTokens 记 0，只有命中时的读取价。
 * 也没有 web search 计费项。
 */
export const COST_DEEPSEEK_FLASH = {
  inputTokens: 0.3,
  outputTokens: 1.2,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.006,
  webSearchRequests: 0,
} as const satisfies ModelCosts

export const COST_DEEPSEEK_V4_PRO = {
  inputTokens: 1.32,
  outputTokens: 3.96,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.044,
  webSearchRequests: 0,
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = COST_DEEPSEEK_FLASH

/**
 * 主模型（默认 deepseek-flash）的成本档。
 *
 * 原本是 `getOpus46CostTier(fastMode)`，带一个"快速模式"高价档 ——
 * 那是上游概念，DeepSeek 没有对应计价，已随模型表一起移除。
 */
export function getDefaultModelCostTier(): ModelCosts {
  return COST_DEEPSEEK_FLASH
}

// @[MODEL LAUNCH]: 新增模型时在这里补一条定价。
// 价格来源：https://api-docs.deepseek.com/quick_start/pricing
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(DEEPSEEK_FLASH_CONFIG.firstParty)]:
    COST_DEEPSEEK_FLASH,
  [firstPartyNameToCanonical(DEEPSEEK_V4_PRO_CONFIG.firstParty)]:
    COST_DEEPSEEK_V4_PRO,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(model)

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('limkenion_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
