import type { Command } from '../../commands.js'
import { isKairosCronEnabled } from '../../tools/ScheduleCronTool/prompt.js'

const schedule = {
  type: 'local',
  name: 'schedule',
  description: '查看与管理本地定时任务',
  argumentHint: '[remove <id>]',
  // 本地定时能力一直都有（CronCreate/CronList/CronDelete 工具），
  // 但一直缺一个命令入口 —— 之前只有走云端的 /schedule 技能。
  isEnabled: () => isKairosCronEnabled(),
  supportsNonInteractive: false,
  load: () => import('./schedule.js'),
} satisfies Command

export default schedule
