/**
 * 微型监听器集合原语，用于纯事件信号（不存储状态）。
 *
 * 将代码库中重复约 15 次的
 * `const listeners = new Set(); function subscribe(){…};
 * function notify(){for(const l of listeners) l()}` 样板压成一行。
 *
 * 与 store（AppState、createStore）不同——没有快照、没有 getState。
 * 当订阅者只需要知道「发生了某事」（可选带事件参数），而不需要知道
 * 「当前值是什么」时使用本原语。
 *
 * 用法：
 *   const changed = createSignal<[SettingSource]>()
 *   export const subscribe = changed.subscribe
 *   // 之后：changed.emit('userSettings')
 */

export type Signal<Args extends unknown[] = []> = {
  /** 订阅一个监听器。返回注销函数。 */
  subscribe: (listener: (...args: Args) => void) => () => void
  /** 用给定参数调用所有已订阅的监听器。 */
  emit: (...args: Args) => void
  /** 移除所有监听器。在 dispose/reset 路径中很有用。 */
  clear: () => void
}

export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
