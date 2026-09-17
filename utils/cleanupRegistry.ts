/**
 * 用于在优雅关闭期间运行的清理函数的全局注册表。
 * 该模块与 gracefulShutdown.ts 分开，以避免循环依赖。
 */

// 清理函数的全局注册表
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * 注册一个在优雅关闭期间运行的清理函数。
 * @param cleanupFn - 清理期间运行的函数（可以是同步或异步）
 * @returns 注销函数，用于移除该清理处理器
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // 返回注销函数
}

/**
 * 运行所有已注册的清理函数。
 * 由 gracefulShutdown 内部使用。
 */
export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
