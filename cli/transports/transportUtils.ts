import { URL } from 'url'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { HybridTransport } from './HybridTransport.js'
import { SSETransport } from './SSETransport.js'
import type { Transport } from './Transport.js'
import { WebSocketTransport } from './WebSocketTransport.js'

/**
 * 获取 URL 对应的合适传输方式的辅助函数。
 *
 * 传输方式选择优先级：
 * 1. 设置了 LIMKENION_USE_CCR_V2 时用 SSETransport（SSE 读 + POST 写）
 * 2. 设置了 LIMKENION_POST_FOR_SESSION_INGRESS_V2 时用 HybridTransport（WS 读 + POST 写）
 * 3. WebSocketTransport（WS 读 + WS 写）——默认
 */
export function getTransportForUrl(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
): Transport {
  if (isEnvTruthy(process.env.LIMKENION_USE_CCR_V2)) {
    // v2：SSE 用于读，HTTP POST 用于写
    // --sdk-url 是会话 URL（.../sessions/{id}）；
    // 通过在末尾追加 /worker/events/stream 派生 SSE 流 URL
    const sseUrl = new URL(url.href)
    if (sseUrl.protocol === 'wss:') {
      sseUrl.protocol = 'https:'
    } else if (sseUrl.protocol === 'ws:') {
      sseUrl.protocol = 'http:'
    }
    sseUrl.pathname =
      sseUrl.pathname.replace(/\/$/, '') + '/worker/events/stream'
    return new SSETransport(sseUrl, headers, sessionId, refreshHeaders)
  }

  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    if (isEnvTruthy(process.env.LIMKENION_POST_FOR_SESSION_INGRESS_V2)) {
      return new HybridTransport(url, headers, sessionId, refreshHeaders)
    }
    return new WebSocketTransport(url, headers, sessionId, refreshHeaders)
  } else {
    throw new Error(`不支持该协议：${url.protocol}`)
  }
}
