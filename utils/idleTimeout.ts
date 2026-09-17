import { logForDebugging } from './debug.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'

/**
 * 为 SDK 模式创建空闲超时管理器。
 * 在指定的空闲时长过后自动退出进程。
 *
 * @param isIdle 若系统当前处于空闲则返回 true 的函数
 * @returns 带有 start/stop 方法来控制空闲定时器
 */
export function createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
} {
  // 解析 LIMKENION_EXIT_AFTER_STOP_DELAY 环境变量
  const exitAfterStopDelay = process.env.LIMKENION_EXIT_AFTER_STOP_DELAY
  const delayMs = exitAfterStopDelay ? parseInt(exitAfterStopDelay, 10) : null
  const isValidDelay = delayMs && !isNaN(delayMs) && delayMs > 0

  let timer: NodeJS.Timeout | null = null
  let lastIdleTime = 0

  return {
    start() {
      // 清除任何现有定时器
      if (timer) {
        clearTimeout(timer)
        timer = null
      }

      // 仅当延迟已配置且有效时才启动定时器
      if (isValidDelay) {
        lastIdleTime = Date.now()

        timer = setTimeout(() => {
          // 检查我们是否已连续空闲了完整时长
          const idleDuration = Date.now() - lastIdleTime
          if (isIdle() && idleDuration >= delayMs) {
            logForDebugging(`空闲 ${delayMs}ms 后退出`)
            gracefulShutdownSync()
          }
        }, delayMs)
      }
    },

    stop() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
