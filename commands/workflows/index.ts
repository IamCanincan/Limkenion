import type { Command } from '../../commands.js'
import { areWorkflowsEnabled } from '../../utils/workflows/enabled.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: '查看并管理动态工作流运行',
  isEnabled: () => areWorkflowsEnabled(),
  load: () => import('./workflows.js'),
} satisfies Command

export default workflows
