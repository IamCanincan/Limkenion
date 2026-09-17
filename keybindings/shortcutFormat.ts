import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { loadKeybindingsSync } from './loadUserBindings.js'
import { getBindingDisplayText } from './resolver.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): 迁移完成后，并确认不再记录
// 'keybinding_fallback_used' 事件时，移除 fallback 参数。
// fallback 是迁移期间的安全网——若绑定加载失败或找不到某个 action，
// 则回退到硬编码值。待其稳定后，调用方应能信任
// getBindingDisplayText 对已知 action 始终返回一个值，
// 届时即可移除这一防御性
// 写法。

// 记录哪些 action+context 组合已经上报过降级事件，
// 以避免非 React 上下文中重复调用产生重复事件。
const LOGGED_FALLBACKS = new Set<string>()

/**
 * 在不使用 React hooks 的情况下获取已配置快捷键的显示文本。
 * 在非 React 上下文中使用（命令、服务等）。
 *
 * 它单独放在一个模块中（而不是 useShortcutDisplay.ts），这样
 * 像 query/stopHooks.ts 这样的非 React 调用方就不会通过同级的
 * hook 把 React 引入它们的模块图。
 *
 * @param action - 动作名称（例如 'app:toggleTranscript'）
 * @param context - 键位绑定上下文（例如 'Global'）
 * @param fallback - 未找到绑定时使用的降级文本
 * @returns 已配置快捷键的显示文本
 *
 * @example
 * const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // 返回用户配置的绑定，未配置时默认返回 'ctrl+o'
 */
export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const bindings = loadKeybindingsSync()
  const resolved = getBindingDisplayText(action, context, bindings)
  if (resolved === undefined) {
    const key = `${action}:${context}`
    if (!LOGGED_FALLBACKS.has(key)) {
      LOGGED_FALLBACKS.add(key)
      logEvent('limkenion_keybinding_fallback_used', {
        action:
          action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        context:
          context as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback:
          fallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reason:
          'action_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    return fallback
  }
  return resolved
}
