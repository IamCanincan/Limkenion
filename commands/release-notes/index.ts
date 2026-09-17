import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: '查看发布说明',
  name: 'release-notes',
  type: 'local',
  // 无网站与云服务：发布说明原本从远程 CHANGELOG 拉取，本地没有可读的源。
  isEnabled: () => false,
  supportsNonInteractive: true,
  load: () => import('./release-notes.js'),
}

export default releaseNotes
