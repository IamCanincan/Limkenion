// 超时值常量
const DEFAULT_TIMEOUT_MS = 120_000 // 2 分钟
const MAX_TIMEOUT_MS = 600_000 // 10 分钟

type EnvLike = Record<string, string | undefined>

/**
 * 获取 bash 操作的默认超时时间（毫秒）。
 * 检查 BASH_DEFAULT_TIMEOUT_MS 环境变量，否则返回 2 分钟默认值。
 * @param env 要检查的环境变量（生产环境默认为 process.env）
 */
export function getDefaultBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_DEFAULT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * 获取 bash 操作的最大超时时间（毫秒）。
 * 检查 BASH_MAX_TIMEOUT_MS 环境变量，否则返回 10 分钟默认值。
 * @param env 要检查的环境变量（生产环境默认为 process.env）
 */
export function getMaxBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_MAX_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      // 确保最大超时至少与默认超时一样大
      return Math.max(parsed, getDefaultBashTimeoutMs(env))
    }
  }
  // 始终确保最大超时至少与默认超时一样大
  return Math.max(MAX_TIMEOUT_MS, getDefaultBashTimeoutMs(env))
}
