/**
 * 限流响应头处理门面。
 *
 * 原本这里是 mock 限流的接线层（给 `/mock-limits` 命令用）。整套 mock 已删除：
 * - `services/mockRateLimits.ts`（719 行）的 `shouldProcessMockLimits()` 开头就是
 *   `if (true) return false`，本来就是硬关掉的死代码；
 * - 它模拟的是"按模型分档的限流窗口"，那是上游服务端才有的概念，
 *   DeepSeek 根本不发这类响应头。
 *
 * 保留这几个导出是为了不动调用方（limkenionAiLimits / api/errors / withRetry /
 * RateLimitMessage）。它们现在都是恒等或空操作。
 */

import type { APIError } from '../types/llm-protocol.js'

/** 原样返回 —— 没有 mock 需要注入。 */
export function processRateLimitHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  return headers
}

/**
 * 是否处理限流。
 * 原本是 `isSubscriber || shouldProcessMockLimits()`；mock 已删，
 * 所以只取决于订阅状态（本构建里恒为 false）。
 */
export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return isSubscriber
}

/** mock 已删除，永远不抛模拟的 429。 */
export function checkMockRateLimitError(
  _currentModel: string,
  _isFastModeActive?: boolean,
): APIError | null {
  return null
}

/** mock 已删除，不会有模拟的限流错误。 */
export function isMockRateLimitError(_error: APIError): boolean {
  return false
}

/** mock 已删除。保留导出是为了不动 RateLimitMessage 的调用点。 */
export function shouldProcessMockLimits(): boolean {
  return false
}
