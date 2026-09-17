import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: '显示你的 Limkenion 用量统计与活动',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
