import { useEffect, useRef } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): 迁移完成后，并确认不再记录
// 'keybinding_fallback_used' 事件时，移除 fallback 参数。
// fallback 是迁移期间的安全网——若绑定加载失败或找不到某个 action，
// 则回退到硬编码值。待其稳定后，调用方应能信任
// getBindingDisplayText 对已知 action 始终返回一个值，
// 届时即可移除这一防御性写法。

/**
 * 获取已配置快捷键显示文本的 hook。
 * 返回已配置的绑定；若不可用则返回降级值。
 *
 * @param action - 动作名称（例如 'app:toggleTranscript'）
 * @param context - 键位绑定上下文（例如 'Global'）
 * @param fallback - 键位绑定上下文不可用时的降级文本
 * @returns 已配置快捷键的显示文本
 *
 * @example
 * const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // 返回用户配置的绑定，未配置时默认返回 'ctrl+o'
 */
export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const keybindingContext = useOptionalKeybindingContext()
  const resolved = keybindingContext?.getDisplayText(action, context)
  const isFallback = resolved === undefined
  const reason = keybindingContext ? 'action_not_found' : 'no_context'

  // 每次挂载只记录一次降级使用（而非每次渲染），以避免
  // 频繁重渲染产生的事件淹没分析系统。
  const hasLoggedRef = useRef(false)
  useEffect(() => {
    if (isFallback && !hasLoggedRef.current) {
      hasLoggedRef.current = true
      logEvent('limkenion_keybinding_fallback_used', {
        action:
          action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        context:
          context as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback:
          fallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reason:
          reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }, [isFallback, action, context, fallback, reason])

  return isFallback ? fallback : resolved
}
