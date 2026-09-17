import type { Command } from '../../commands.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: '你的 2025 年 Limkenion 年度回顾',
  isEnabled: () =>
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('limkenion_thinkback'),
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
