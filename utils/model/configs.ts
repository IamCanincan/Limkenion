import type { ModelName } from './model.js'

/**
 * 本构建只支持 DeepSeek（OpenAI 兼容端点）。
 *
 * 上游那张「一个模型 × 4 个供应商（firstParty / bedrock / vertex / foundry）」的配置表
 * 已整体移除 —— Bedrock / Vertex / Foundry 的路由在项目改造时就被删掉了，
 * `getAPIProvider()` 恒返回 `'firstParty'`，另外三个分支永远不可达。
 * 模型名以实测 `GET https://api.deepseek.com/models` 为准（2026-09-17：两个模型）。
 *
 * **别凭印象加模型，先打接口确认。**
 */
export type ModelConfig = { firstParty: ModelName }

export const DEEPSEEK_FLASH_CONFIG = {
  firstParty: 'deepseek-flash',
} as const satisfies ModelConfig

export const DEEPSEEK_V4_PRO_CONFIG = {
  firstParty: 'deepseek-v4-pro',
} as const satisfies ModelConfig

export const ALL_MODEL_CONFIGS = {
  deepseekFlash: DEEPSEEK_FLASH_CONFIG,
  deepseekV4Pro: DEEPSEEK_V4_PRO_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical model IDs，即 'deepseek-flash' | 'deepseek-v4-pro' */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
