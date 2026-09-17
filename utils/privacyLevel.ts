/**
 * 隐私级别控制 Limkenion 产生多少非必要网络流量和遥测。
 *
 * 级别按限制程度排序：
 *   default < no-telemetry < essential-traffic
 *
 * - default:            全部启用。
 * - no-telemetry:       禁用分析/遥测（Datadog、1P 事件、反馈调查）。
 * - essential-traffic:  禁用所有非必要网络流量
 *                       （遥测 + 自动更新、grove、发行说明、模型能力等）。
 *
 * 解析后的级别取下列中最严格的一个信号：
 *   LIMKENION_DISABLE_NONESSENTIAL_TRAFFIC  →  essential-traffic
 *   DISABLE_TELEMETRY                         →  no-telemetry
 */

type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env.LIMKENION_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'essential-traffic'
  }
  if (process.env.DISABLE_TELEMETRY) {
    return 'no-telemetry'
  }
  return 'default'
}

/**
 * 当所有非必要网络流量都应被抑制时为 true。
 * 等价于旧的 `process.env.LIMKENION_DISABLE_NONESSENTIAL_TRAFFIC` 检查。
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
 * 当遥测/分析应被抑制时为 true。
 * 在 `no-telemetry` 和 `essential-traffic` 级别都为 true。
 */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

/**
 * 返回引发当前 essential-traffic 限制的环境变量名；若未受限则返回 null。
 * 用于面向用户的「取消设置 X 以重新启用」消息。
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (process.env.LIMKENION_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'LIMKENION_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  return null
}
