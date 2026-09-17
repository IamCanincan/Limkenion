import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

/**
 * /ultrareview 的运行时开关。GB 配置的 `enabled` 字段控制
 * 可见性——isEnabled() 会在其为 false 时将该命令从 getCommands()
 * 中过滤掉，因此未开启的用户完全看不到该命令。
 */
export function isUltrareviewEnabled(): boolean {
  const cfg = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('limkenion_review_bughunter_config', null)
  return cfg?.enabled === true
}
