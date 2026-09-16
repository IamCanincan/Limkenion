import type { Command } from '../../commands.js'

const web = {
  type: 'local-jsx',
  name: 'web',
  description: 'Start the Limkenion web UI server and open it in your browser',
  load: () => import('./web.js'),
} satisfies Command

export default web
