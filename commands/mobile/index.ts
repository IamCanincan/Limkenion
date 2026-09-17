import type { Command } from '../../commands.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: '显示下载 Limkenion 移动应用的二维码',
  // Limkenion 无任何网站与云服务：移动端 App 并不存在，此命令无从指向。
  // 按项目既有惯例（teleport / bughunter 等）以 isEnabled 关闭，代码保留便于日后清理。
  isEnabled: () => false,
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
