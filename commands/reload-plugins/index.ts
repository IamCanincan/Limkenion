/**
 * /reload-plugins —— 第 3 层刷新。把待处理的插件变更应用到
 * 正在运行的会话。实现按需懒加载。
 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',
  name: 'reload-plugins',
  description: '在当前会话中激活待生效的插件更改',
  // SDK 调用方使用 query.reloadPlugins()（控制请求），而不是
  // 把它作为文本提示词发送 —— 前者会返回结构化数据
  //（commands、agents、plugins、mcpServers）用于 UI 更新。
  supportsNonInteractive: false,
  load: () => import('./reload-plugins.js'),
} satisfies Command

export default reloadPlugins
