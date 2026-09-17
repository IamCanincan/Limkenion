/**
 * 通过 AsyncLocalStorage 的回合作用域工作负载标签。
 *
 * 为什么单独建模块而不是放进 bootstrap/state.ts：
 * bootstrap 被 src/entrypoints/browser-sdk.ts 传递性导入，而浏览器打包不能
 * 导入 Node 的 async_hooks。本模块只从绝不出现在浏览器构建中的 CLI/SDK
 * 代码路径导入。
 *
 * 为什么用 AsyncLocalStorage（而非全局可变槽）：
 * void 分离的后台智能体（executeForkedSlashCommand、AgentTool）会在首次
 * await 处让出。父回合的同步续接——包括任何 `finally` 块——会在分离的闭包
 * 恢复前运行完毕。在闭包顶部设置全局 setWorkload('cron') 会被确定性地抹掉。
 * ALS 在调用时捕获上下文，并在该链的每次 await 中存活，与父回合隔离。
 * 与 agentContext.ts 采用相同模式。
 */

import { AsyncLocalStorage } from 'async_hooks'

/**
 * 服务端净化器（limkenion.py 中的 _sanitize_entrypoint）只接受小写
 * [a-z0-9_-]{0,32}。大写会在第 0 个字符处停止解析。
 */
export type Workload = 'cron'
export const WORKLOAD_CRON: Workload = 'cron'

const workloadStorage = new AsyncLocalStorage<{
  workload: string | undefined
}>()

export function getWorkload(): string | undefined {
  return workloadStorage.getStore()?.workload
}

/**
 * 把 `fn` 包装进工作负载 ALS 上下文。即便 `workload` 为 undefined，
 * 也总是建立新的上下文边界。
 *
 * 之前的实现在 `undefined` 时用 `return fn()` 短路——但那是透传，不是边界。
 * 如果调用方已位于泄漏的 cron 上下文中（REPL：queryGuard.end() →
 * _notify() → React 订阅者 → 调度时的重渲染捕获 ALS →
 * useQueueProcessor effect → executeQueuedInput → 此处），一次透传会让 `fn`
 * 内部的 getWorkload() 返回泄漏的标签。一旦泄漏就永久粘滞：每个回合的结束
 * 通知都会把环境上下文重新传播给下一回合的调度链。
 *
 * 总是调用 `.run()` 可保证 `fn` 内部的 getWorkload() 返回调用方传入的
 * 确切值——包括 `undefined`。
 */
export function runWithWorkload<T>(
  workload: string | undefined,
  fn: () => T,
): T {
  return workloadStorage.run({ workload }, fn)
}
