import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getRateLimitTier, getSubscriptionType } from './auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

export function getPlanModeV2AgentCount(): number {
  // 环境变量覆盖优先
  if (process.env.LIMKENION_PLAN_V2_AGENT_COUNT) {
    const count = parseInt(process.env.LIMKENION_PLAN_V2_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()

  if (
    subscriptionType === 'max' &&
    rateLimitTier === 'default_limkenion_max_20x'
  ) {
    return 3
  }

  if (subscriptionType === 'enterprise' || subscriptionType === 'team') {
    return 3
  }

  return 1
}

export function getPlanModeV2ExploreAgentCount(): number {
  if (process.env.LIMKENION_PLAN_V2_EXPLORE_AGENT_COUNT) {
    const count = parseInt(
      process.env.LIMKENION_PLAN_V2_EXPLORE_AGENT_COUNT,
      10,
    )
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  return 3
}

/**
 * 检查计划模式访谈阶段是否启用。
 *
 * 配置：ant=始终开启, external=limkenion_plan_mode_interview_phase 门控, envVar=true
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  // 对 ant 始终开启
  

  const env = process.env.LIMKENION_PLAN_MODE_INTERVIEW_PHASE
  if (isEnvTruthy(env)) return true
  if (isEnvDefinedFalsy(env)) return false

  return getFeatureValue_CACHED_MAY_BE_STALE(
    'limkenion_plan_mode_interview_phase',
    false,
  )
}

export type PewterLedgerVariant = 'trim' | 'cut' | 'cap' | null

/**
 * limkenion_pewter_ledger — 计划文件结构 prompt 实验。
 *
 * 控制 5 阶段计划模式工作流（messages.ts 的 getPlanPhase4Section）中
 * 阶段 4 "Final Plan" 的要点。5 阶段占计划流量的 99%；访谈阶段（ant）
 * 作为参考人群保持不变。
 *
 * 分支：null（对照）、'trim'、'cut'、'cap' — 对计划文件大小的
 * 指导逐渐收紧。
 *
 * 基线（对照，结算至 2026-03-02，N=26.3M）：
 *   p50 4,906 字符 | p90 11,617 | 均值 6,207 | 82% deepseek-v4-pro
 *   拒绝率随大小单调递增：<2K 时为 20% → 20K+ 时50%
 *
 * 主要指标：会话级平均成本（fact__201omjcij85f）——deepseek-v4-pro 输出价格为
 *   输入价格的 5 倍，因此成本是输出加权代理。limkenion_plan_exit 上的
 *   planLengthChars 是机制，但不是目标——cap 分支可能通过
 *   write→count→edit 循环在缩小计划文件的同时增加总输出。
 * 护栏：feedback-bad 率、请求/会话（过薄的计划 →
 *   更多实现迭代）、工具错误率
 */
export function getPewterLedgerVariant(): PewterLedgerVariant {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<string | null>(
    'limkenion_pewter_ledger',
    null,
  )
  if (raw === 'trim' || raw === 'cut' || raw === 'cap') return raw
  return null
}
