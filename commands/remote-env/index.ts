import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isLimkenionAISubscriber } from '../../utils/auth.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: '配置 teleport 会话的默认远程环境',
  isEnabled: () =>
    isLimkenionAISubscriber() && isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isLimkenionAISubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env.js'),
} satisfies Command
