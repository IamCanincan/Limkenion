import type { Command } from '../../commands.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: '显示下载 Limkenion 移动应用的二维码',
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
