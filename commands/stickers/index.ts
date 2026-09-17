import type { Command } from '../../commands.js'

const stickers = {
  type: 'local',
  name: 'stickers',
  description: '订购 Limkenion 贴纸',
  // 无网站与云服务：周边商店（stickermule）不存在，此命令无从指向。
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: () => import('./stickers.js'),
} satisfies Command

export default stickers
