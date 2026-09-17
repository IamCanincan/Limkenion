import type { Command } from '../../commands.js'

const web = {
  type: 'local-jsx',
  name: 'web',
  description: '启动 Limkenion Web UI 服务器并在浏览器中打开',
  load: () => import('./web.js'),
} satisfies Command

export default web
