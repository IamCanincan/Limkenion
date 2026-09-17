import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: '显示套餐用量限制',
  availability: ['limkenion-ai'],
  load: () => import('./usage.js'),
} satisfies Command
