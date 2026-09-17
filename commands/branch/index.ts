import { feature } from 'bun:bundle'
import type { Command } from '../../commands.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  // 仅当 /fork 尚未作为独立命令存在时，才使用 'fork' 别名
  aliases: feature('FORK_SUBAGENT') ? [] : ['fork'],
  description: '在当前会话的此处分叉出一个分支',
  argumentHint: '[name]',
  load: () => import('./branch.js'),
} satisfies Command

export default branch
