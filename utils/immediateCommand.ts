import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

/**
 * 推理配置命令（/model、/fast、/effort）是否应立即执行（在正在运行的
 * 查询期间），而不是等待当前回合结束。
 *
 * 对 ants 始终启用；对外部用户由实验控制。
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    (getFeatureValue_CACHED_MAY_BE_STALE('limkenion_immediate_model_command', false))
  )
}
