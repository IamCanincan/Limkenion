import { createAbortController } from './abortController.js'

/**
 * 创建一个组合 AbortSignal：当输入信号中止、可选第二个信号中止，或可选
 * 超时到期时中止。同时返回该信号和一个清理函数，后者会移除事件监听器并
 * 清除内部超时定时器。
 *
 * 使用 `timeoutMs` 而非把 `AbortSignal.timeout(ms)` 作为信号传入——在 Bun
 * 下，AbortSignal.timeout 的定时器会延迟终结并在原生内存中累积，直到触发
 * 才释放（实测每次调用在完整超时期间约持有 2.4KB）。本实现使用
 * setTimeout + clearTimeout，因此在清理时定时器立即可释放。
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs } = opts ?? {}
  const combined = createAbortController()

  if (signal?.aborted || signalB?.aborted) {
    combined.abort()
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const abortCombined = () => {
    if (timer !== undefined) clearTimeout(timer)
    combined.abort()
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortCombined, timeoutMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', abortCombined)
  signalB?.addEventListener('abort', abortCombined)

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abortCombined)
    signalB?.removeEventListener('abort', abortCombined)
  }

  return { signal: combined.signal, cleanup }
}
