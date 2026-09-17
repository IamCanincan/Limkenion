/**
 * color 命令 —— 仅含最小元数据。
 * 实现从 color.ts 惰性加载，以减少启动时间。
 */
import type { Command } from '../../commands.js'

const color = {
  type: 'local-jsx',
  name: 'color',
  description: '设置当前会话的提示栏颜色',
  immediate: true,
  argumentHint: '<color|default>',
  load: () => import('./color.js'),
} satisfies Command

export default color
