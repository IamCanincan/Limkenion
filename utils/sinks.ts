import { initializeAnalyticsSink } from '../services/analytics/sink.js'
import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * 挂载错误日志与分析 sink，并排干在挂载前排队的任何事件。两次初始化
 * 都是幂等的。由 setup() 为默认命令调用；其他入口点（子命令、daemon、
 * bridge）直接调用本函数，因为它们绕过了 setup()。
 *
 * 叶子模块 —— 不放进 setup.ts，以避免 setup → commands → bridge
 * → setup 的导入循环。
 */
export function initSinks(): void {
  initializeErrorLogSink()
  initializeAnalyticsSink()
}
