import { useCallback, useEffect } from 'react'
import type { InputEvent } from '../ink/events/input-event.js'
import { type Key, useInput } from '../ink.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

type Options = {
  /** 该绑定所属的上下文（默认：'Global'） */
  context?: KeybindingContextName
  /** 仅在激活时处理（类似 useInput 的 isActive） */
  isActive?: boolean
}

/**
 * 用于处理键位绑定的 Ink 原生 hook。
 *
 * 处理函数保留在组件中（React 风格）。
 * 绑定关系（按键 → 动作）来自配置。
 *
 * 支持组合键序列（例如 "ctrl+k ctrl+s"）。当开始一个组合键时，
 * 该 hook 会自动管理待处理状态。
 *
 * 使用 stopImmediatePropagation() 防止其他处理函数在该绑定
 * 被处理后触发。
 *
 * @example
 * ```tsx
 * useKeybinding('app:toggleTodos', () => {
 *   setShowTodos(prev => !prev)
 * }, { context: 'Global' })
 * ```
 */
export function useKeybinding(
  action: string,
  handler: () => void | false | Promise<void>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // 将处理函数注册到上下文中，供 ChordInterceptor 调用
  useEffect(() => {
    if (!keybindingContext || !isActive) return
    return keybindingContext.registerHandler({ action, context, handler })
  }, [action, context, handler, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // 如果没有可用的键位绑定上下文，则跳过解析
      if (!keybindingContext) return

      // 构建上下文列表：已注册的激活上下文 + 当前上下文 + Global
      // 更具体的上下文（已注册的）优先于 Global
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // 去重并保持顺序（首次出现的优先级更高）
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // 组合键已完成（如果有）——清除待处理状态
          keybindingContext.setPendingChord(null)
          if (result.action === action) {
            if (handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // 用户开始了组合键序列——更新待处理状态
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // 组合键被取消（escape 或无效按键）
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // 显式解除绑定——清除任何待处理的组合键
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // 无匹配——让其他处理函数尝试
          break
      }
    },
    [action, context, handler, keybindingContext],
  )

  useInput(handleInput, { isActive })
}

/**
 * 在一个 hook 中处理多个键位绑定（减少 useInput 调用）。
 *
 * 支持组合键序列。当开始一个组合键时，该 hook 会自动
 * 管理待处理状态。
 *
 * @example
 * ```tsx
 * useKeybindings({
 *   'chat:submit': () => handleSubmit(),
 *   'chat:cancel': () => handleCancel(),
 * }, { context: 'Chat' })
 * ```
 */
export function useKeybindings(
  // 处理函数返回 `false` 表示“未消费”——事件会继续传播
  // 给后续的 useInput/useKeybindings 处理函数。用于穿透场景：
  // 例如 ScrollKeybindingHandler 的 scroll:line* 在
  // ScrollBox 内容可完整显示时返回 false（滚动是空操作），让子组件的
  // 处理函数接管滚轮事件以进行列表导航。对于即发即忘的异步处理函数，
  // 允许返回 Promise<void>（`!== false` 检查
  // 只对同步的 `false` 跳过传播，而不是待处理的 Promise）。
  handlers: Record<string, () => void | false | Promise<void>>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // 将所有处理函数注册到上下文中，供 ChordInterceptor 调用
  useEffect(() => {
    if (!keybindingContext || !isActive) return

    const unregisterFns: Array<() => void> = []
    for (const [action, handler] of Object.entries(handlers)) {
      unregisterFns.push(
        keybindingContext.registerHandler({ action, context, handler }),
      )
    }

    return () => {
      for (const unregister of unregisterFns) {
        unregister()
      }
    }
  }, [context, handlers, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // 如果没有可用的键位绑定上下文，则跳过解析
      if (!keybindingContext) return

      // 构建上下文列表：已注册的激活上下文 + 当前上下文 + Global
      // 更具体的上下文（已注册的）优先于 Global
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // 去重并保持顺序（首次出现的优先级更高）
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // 组合键已完成（如果有）——清除待处理状态
          keybindingContext.setPendingChord(null)
          if (result.action in handlers) {
            const handler = handlers[result.action]
            if (handler && handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // 用户开始了组合键序列——更新待处理状态
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // 组合键被取消（escape 或无效按键）
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // 显式解除绑定——清除任何待处理的组合键
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // 无匹配——让其他处理函数尝试
          break
      }
    },
    [context, handlers, keybindingContext],
  )

  useInput(handleInput, { isActive })
}
