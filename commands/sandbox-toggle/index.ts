import figures from 'figures'
import type { Command } from '../../commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

const command = {
  name: 'sandbox',
  get description() {
    const currentlyEnabled = SandboxManager.isSandboxingEnabled()
    const autoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled()
    const allowUnsandboxed = SandboxManager.areUnsandboxedCommandsAllowed()
    const isLocked = SandboxManager.areSandboxSettingsLockedByPolicy()
    const hasDeps = SandboxManager.checkDependencies().errors.length === 0

    // 缺少依赖时显示警告图标，否则显示启用/禁用状态
    let icon: string
    if (!hasDeps) {
      icon = figures.warning
    } else {
      icon = currentlyEnabled ? figures.tick : figures.circle
    }

    let statusText = 'sandbox disabled'
    if (currentlyEnabled) {
      statusText = autoAllow
        ? 'sandbox enabled (auto-allow)'
        : 'sandbox enabled'

      // 添加非沙箱降级状态
      statusText += allowUnsandboxed ? ', fallback allowed' : ''
    }

    if (isLocked) {
      statusText += ' (managed)'
    }

    return `${icon} ${statusText} (⏎ to configure)`
  },
  argumentHint: 'exclude "command pattern"',
  get isHidden() {
    return (
      !SandboxManager.isSupportedPlatform() ||
      !SandboxManager.isPlatformInEnabledList()
    )
  },
  immediate: true,
  type: 'local-jsx',
  load: () => import('./sandbox-toggle.js'),
} satisfies Command

export default command
