import type { Command } from '../../commands.js'
import {
  checkCachedPassesEligibility,
  getCachedReferrerReward,
} from '../../services/api/referral.js'

export default {
  type: 'local-jsx',
  name: 'passes',
  get description() {
    const reward = getCachedReferrerReward()
    if (reward) {
      return '与朋友分享 Limkenion 免费周并获得额外用量'
    }
    return '与朋友分享 Limkenion 免费周'
  },
  get isHidden() {
    const { eligible, hasCache } = checkCachedPassesEligibility()
    return !eligible || !hasCache
  },
  // 无网站与云服务：guest passes 是账号侧的邀请奖励，本地模式下无从获得。
  isEnabled: () => false,
  load: () => import('./passes.js'),
} satisfies Command
