import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: '显示套餐用量限制',
  availability: ['cloud-subscriber'],
  load: () => import('./usage.js'),
} satisfies Command
