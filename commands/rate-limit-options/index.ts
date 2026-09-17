import type { Command } from '../../commands.js'
import { isLimkenionAISubscriber } from '../../utils/auth.js'

const rateLimitOptions = {
  type: 'local-jsx',
  name: 'rate-limit-options',
  description: '在触达速率限制时显示选项',
  isEnabled: () => {
    if (!isLimkenionAISubscriber()) {
      return false
    }

    return true
  },
  isHidden: true, // 在帮助中隐藏 —— 仅供内部使用
  load: () => import('./rate-limit-options.js'),
} satisfies Command

export default rateLimitOptions
