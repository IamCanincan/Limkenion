import type { Command } from '../../commands.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: 'Your 2025 Limkenion Year in Review',
  isEnabled: () =>
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('内部代号_thinkback'),
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
