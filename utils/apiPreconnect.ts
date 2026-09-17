/**
 * 预连接到 Limkenion API，使 TCP+TLS 握手与启动重叠。
 *
 * TCP+TLS 握手约需 100-200ms，通常阻塞在首次 API 调用内。在 init 期间发起
 * 一次即发即忘的 fetch，可让握手与 action-handler 工作并行（在 -p 模式下，
 * 到 API 请求前有约 100ms 的 setup/commands/mcp；交互模式下则是不受限的
 * "user is typing" 窗口）。
 *
 * Bun 的 fetch 全局共享 keep-alive 连接池，因此真正的 API 请求会复用
 * 预热好的连接。
 *
 * 在 applyExtraCACertsFromConfig() + configureGlobalAgents() 之后从 init.ts
 * 调用，以确保 settings.json 环境变量生效、TLS 证书存储已定型。早期 cli.tsx
 * 调用点已被移除——它在 settings.json 加载之前运行，因此 settings 中的
 * LIMKENION_BASE_URL/proxy/mTLS 会不可见，预连接会预热错误的连接池（或更糟，
 * 在应用 NODE_EXTRA_CA_CERTS 之前锁定 BoringSSL 的证书存储）。
 *
 * 在以下情况下跳过：
 * - 配置了 proxy/mTLS/unix socket（预连接会使用错误的传输层——SDK 传入
 *   不共享全局连接池的自定义 dispatcher/agent）
 * - Bedrock/Vertex/Foundry（不同端点、不同认证）
 */

import { getOauthConfig } from '../constants/oauth.js'
import { isEnvTruthy } from './envUtils.js'

let fired = false

export function preconnectLimkenionApi(): void {
  if (fired) return
  fired = true

  // 若使用云提供方则跳过——端点与认证都不同
  if (
    isEnvTruthy(process.env.LIMKENION_USE_BEDROCK) ||
    isEnvTruthy(process.env.LIMKENION_USE_VERTEX) ||
    isEnvTruthy(process.env.LIMKENION_USE_FOUNDRY)
  ) {
    return
  }
  // 若使用 proxy/mTLS/unix 则跳过——SDK 的自定义 dispatcher 不会复用此连接池
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.LIMKENION_UNIX_SOCKET ||
    process.env.LIMKENION_CLIENT_CERT ||
    process.env.LIMKENION_CLIENT_KEY
  ) {
    return
  }

  // 使用配置的 base URL（staging、local 或自定义网关）。一次查找即涵盖
  // LIMKENION_BASE_URL 环境变量 + USE_STAGING_OAUTH + USE_LOCAL_OAUTH。
  // NODE_EXTRA_CA_CERTS 不再是跳过条件——init.ts 已在本函数触发前应用它。
  const baseUrl =
    process.env.LIMKENION_BASE_URL || getOauthConfig().BASE_API_URL

  // 即发即忘。HEAD 表示无响应体——连接在响应头到达后立即可复用 keep-alive
  // 连接池。10s 超时保证慢网络不会挂起进程；中止也没关系，因为真正的请求
  // 如需握手仍会重新握手。
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  void fetch(baseUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}
