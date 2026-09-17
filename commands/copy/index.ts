/**
 * Copy 命令 - 仅保留最小元数据。
 * 实现从 copy.tsx 懒加载，以缩短启动时间。
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    "将 Limkenion 的最后一条回复复制到剪贴板（或 /copy N 复制倒数第 N 条）",
  load: () => import('./copy.js'),
} satisfies Command

export default copy
