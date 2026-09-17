import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

/** 是否运行在 OpenAI 兼容模式（DeepSeek / 任意 OpenAI 格式端点）。 */
export function isOpenAICompat(): boolean {
  // 显式 provider 标记，或检测到 DeepSeek key（走 OpenAI 协议）都算兼容模式，
  // 这样即便漏配 provider 变量，默认模型也不会回落到上游那套硬编码默认值。
  return (
    process.env.LIMKENION_API_PROVIDER === 'openai' ||
    !!process.env.DEEPSEEK_API_KEY
  )
}

/** OpenAI 兼容模式下的默认主模型（与 services/api/openai-compat.ts 保持一致）。 */
export const OPENAI_COMPAT_DEFAULT_MODEL = 'deepseek-flash'

// Limkenion 已去除对 Amazon Bedrock / Google Vertex AI / Microsoft Foundry 等
// 第三方云供应商的路由支持，当前仅运行于 OpenAI 兼容（DeepSeek）模式。
// getAPIProvider 恒返回 firstParty，使全仓库基于 getAPIProvider() 的分支全部
// 走回第一方/独立路径，不再触发任何 Bedrock/Vertex/Foundry 供应商逻辑。
export function getAPIProvider(): APIProvider {
  return 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if LIMKENION_BASE_URL is a first-party Limkenion API URL.
 * Returns true if not set (default API) or points to 127.0.0.1
 * (or api-staging.limkenion.com for ant users).
 */
export function isFirstPartyLimkenionBaseUrl(): boolean {
  const baseUrl = process.env.LIMKENION_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['127.0.0.1']
    
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
