import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

/**
 * 在当前异步上下文中以覆盖后的工作目录运行函数。
 * 函数内部（及其异步后代）对 pwd()/getCwd() 的所有调用都将返回覆盖后的
 * cwd，而非全局 cwd。这使得并发智能体各自看到自己的工作目录，而互不影响。
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * 获取当前工作目录
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

/**
 * 获取当前工作目录；若当前目录不可用则返回原始工作目录
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
