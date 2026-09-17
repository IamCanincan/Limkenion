import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

/**
 * 本构建是否运行在 OpenAI 兼容模式（DeepSeek / 任意 OpenAI 格式端点）。
 *
 * **恒为 true，不是"检测"出来的。**
 * 上游协议在本项目里已被永久移除 —— `types/llm-protocol.ts` 里的 `Limkenion` 类
 * 只是个会抛错的占位，`.beta` / `.messages` 一碰就抛。所以根本不存在"另一种模式"
 * 可以回退，任何按条件判断的地方一旦判成 false，就会掉进那个已经删掉的世界。
 *
 * 这里踩过一个坑（2026-09-17，用户清空 key 后暴露）：早先把它写成
 * "检测到 key 才算兼容模式"，于是 key 一空 → 返回 false → 全仓库回落到已删除的上游
 * 路径，表现为每次请求都报「上游 client 已移除」，连欢迎屏的模型名都变回上游的
 * deepseek-flash。**"用哪套协议"和"有没有配 key"是两件事，绝不能混进同一个判断。**
 * 有没有 key 由 services/api/openai-compat.ts 的 getConfig() 负责判断并给出提示。
 */
export function isOpenAICompat(): boolean {
  return true
}

/** OpenAI 兼容模式下的默认主模型（与 services/api/openai-compat.ts 保持一致）。 */
export const OPENAI_COMPAT_DEFAULT_MODEL = 'deepseek-flash'

/**
 * OpenAI 兼容模式下可选的模型清单。
 * 来源：实测 `GET https://api.deepseek.com/models`（2026-09-17），
 * DeepSeek 当前只提供这两个。**别凭印象改，以接口返回为准。**
 */
export const OPENAI_COMPAT_MODELS = [
  'deepseek-flash',
  'deepseek-v4-pro',
] as const

/** 兼容模式下的"小快模型"：WebSearch 结果处理、离开回来摘要、agent hooks 等用它。 */
export function getOpenAICompatSmallFastModel(): string {
  return process.env.LIMKENION_SMALL_FAST_MODEL || OPENAI_COMPAT_DEFAULT_MODEL
}

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
