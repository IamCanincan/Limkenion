/**
 * clear 命令 —— 仅含最小元数据。
 * 实现从 clear.ts 惰性加载，以减少启动时间。
 * 工具函数：
 * - clearSessionCaches：从 './clear/caches.js' 导入
 * - clearConversation：从 './clear/conversation.js' 导入
 */
import type { Command } from '../../commands.js'

const clear = {
  type: 'local',
  name: 'clear',
  description: '清除对话历史并释放上下文',
  aliases: ['reset', 'new'],
  supportsNonInteractive: false, // 应当只创建一个新会话
  load: () => import('./clear.js'),
} satisfies Command

export default clear
