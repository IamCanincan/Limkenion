import { feature } from 'bun:bundle'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { redownloadUserSettings } from '../../services/settingsSync/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  // CCR：在清理缓存之前重新拉取用户设置，使 enabledPlugins /
  // extraKnownMarketplaces（由用户本地 CLI 经 settingsSync 推送）
  // 生效。非 CCR 的无头模式（例如 vscode SDK 子进程）与写入设置的
  // 一方共享磁盘 —— 文件监听器会投递变更，那里无需
  // 重新拉取。
  //
  // 有意不重新获取受管设置：它已经每小时轮询一次
  //（POLLING_INTERVAL_MS），且策略执行在设计上就是最终一致的
  //（获取失败时降级使用失效缓存）。交互式
  // /reload-plugins 也从未重新获取过它。
  //
  // 不重试：这是用户主动发起的命令，只尝试一次 + 失败放行。用户
  // 可以重新运行 /reload-plugins 来重试。启动路径保留其重试逻辑。
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.LIMKENION_REMOTE) || getIsRemoteMode())
  ) {
    const applied = await redownloadUserSettings()
    // applyRemoteEntriesToLocal 使用 markInternalWrite 抑制
    // 文件监听器（对启动阶段是正确的，此时还没有监听者）；在这里
    // 触发 notifyChange，以便会话中途能执行 applySettingsChange。
    if (applied) {
      settingsChangeDetector.notifyChange('userSettings')
    }
  }

  const r = await refreshActivePlugins(context.setAppState)

  const parts = [
    n(r.enabled_count, 'plugin'),
    n(r.command_count, 'skill'),
    n(r.agent_count, 'agent'),
    n(r.hook_count, 'hook'),
    // “plugin MCP/LSP” 用于与用户配置/内置服务器区分开，
    // /reload-plugins 不会动后者。Commands/hooks 仅限插件；
    // agent_count 是 agent 总数（含内置）。(gh-31321)
    n(r.mcp_count, 'plugin MCP server'),
    n(r.lsp_count, 'plugin LSP server'),
  ]
  let msg = `Reloaded: ${parts.join(' · ')}`

  if (r.error_count > 0) {
    msg += `\n${n(r.error_count, 'error')} during load. Run /doctor for details.`
  }

  return { type: 'text', value: msg }
}

function n(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}
