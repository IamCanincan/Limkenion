/**
 * profiler 模块（startupProfiler、queryProfiler、headlessProfiler）的
 * 共享基础设施。三者使用相同的 perf_hooks 时间线，以及相同的详细报告行格式。
 */

import type { performance as PerformanceType } from 'perf_hooks'
import { formatFileSize } from './format.js'

// 仅在启用性能分析时才惰性加载 performance API。
// 在所有 profiler 间共享——perf_hooks.performance 是进程级单例。
let performance: typeof PerformanceType | null = null

export function getPerformance(): typeof PerformanceType {
  if (!performance) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    performance = require('perf_hooks').performance
  }
  return performance!
}

export function formatMs(ms: number): string {
  return ms.toFixed(3)
}

/**
 * 以共享的 profiler 报告格式渲染单行时间线：
 *   [+  total.ms] (+  delta.ms) name [extra] [| RSS: .., Heap: ..]
 *
 * totalPad/deltaPad 控制 padStart 宽度，让调用方可以根据预期量级对齐各列
 * （startup 用 8/7，query 用 10/9）。
 */
export function formatTimelineLine(
  totalMs: number,
  deltaMs: number,
  name: string,
  memory: NodeJS.MemoryUsage | undefined,
  totalPad: number,
  deltaPad: number,
  extra = '',
): string {
  const memInfo = memory
    ? ` | RSS: ${formatFileSize(memory.rss)}, Heap: ${formatFileSize(memory.heapUsed)}`
    : ''
  return `[+${formatMs(totalMs).padStart(totalPad)}ms] (+${formatMs(deltaMs).padStart(deltaPad)}ms) ${name}${extra}${memInfo}`
}
