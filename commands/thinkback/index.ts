import type { Command } from '../../commands.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: '你的 2025 年 Limkenion 年度回顾',
  // 无网站与云服务：年度回顾依赖从 GitHub 拉取官方插件市场数据，
  // 且原本由 Statsig 功能开关控制（本地无网络，开关值不可信），直接关闭。
  isEnabled: () => false,
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
