/**
 * cost 命令 —— 仅含最小元数据。
 * 实现从 cost.ts 惰性加载，以减少启动时间。
 */
import type { Command } from '../../commands.js'
import { isLimkenionAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: '显示当前会话的总成本与时长',
  get isHidden() {
    // 即使 Ants 是订阅用户也保持可见（他们能看到成本明细）
    
    return isLimkenionAISubscriber()
  },
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
