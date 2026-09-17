import type { APIError } from '../../types/llm-protocol.js'

// OpenSSL 的 SSL/TLS 错误码（Node.js 和 Bun 均使用）
// 参见: https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
const SSL_ERROR_CODES = new Set([
  // 证书校验错误
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // 自签名证书错误
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // 链错误
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // 主机名/altname 错误
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS 握手错误
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/**
 * 从错误的 cause 链中提取连接错误详情。
 * Limkenion SDK 会把底层错误包裹在 `cause` 属性里。
 * 此函数遍历 cause 链以找到根错误码/错误信息。
 */
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  // 遍历 cause 链以找到带 code 的根错误
  let current: unknown = error
  const maxDepth = 5 // 防止无限循环
  let depth = 0

  while (current && depth < maxDepth) {
    if (
      current instanceof Error &&
      'code' in current &&
      typeof current.code === 'string'
    ) {
      const code = current.code
      const isSSLError = SSL_ERROR_CODES.has(code)
      return {
        code,
        message: current.message,
        isSSLError,
      }
    }

    // 移动到链中的下一个 cause
    if (
      current instanceof Error &&
      'cause' in current &&
      current.cause !== current
    ) {
      current = current.cause
      depth++
    } else {
      break
    }
  }

  return null
}

/**
 * 为 SSL/TLS 错误返回可操作的建议，面向主 API 客户端之外的场景
 * （OAuth token 交换、预检连通性检查），这些地方不适用 `formatAPIError`。
 *
 * 动机：位于 TLS 拦截代理（如 Zscaler 等）之后的企业用户，会在浏览器中
 * 完成 OAuth，但 CLI 的 token 交换却因原始 SSL 错误码而静默失败。
 * 暴露可行的修复方式可省去一轮技术支持往返。
 */
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) {
    return null
  }
  return `SSL 证书错误（${details.code}）。如果你处于公司代理或 TLS 拦截防火墙之后，请将 NODE_EXTRA_CA_CERTS 设置为你的 CA 包路径，或请 IT 把 *.limkenion.com 加入白名单。运行 /doctor 可查看详情。`
}

/**
 * 从消息字符串中剥离 HTML 内容（例如 CloudFlare 错误页），
 * 若检测到 HTML 则返回用户友好的标题或空字符串。
 * 若未发现 HTML 则原样返回消息。
 */
function sanitizeMessageHTML(message: string): string {
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
    const titleMatch = message.match(/<title>([^<]+)<\/title>/)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim()
    }
    return ''
  }
  return message
}

/**
 * 检测错误消息是否包含 HTML 内容（例如 CloudFlare 错误页），
 * 若是则返回用户友好的消息
 */
export function sanitizeAPIError(apiError: APIError): string {
  const message = apiError.message
  if (!message) {
    // 有时 message 为 undefined
    // TODO: 查明原因
    return ''
  }
  return sanitizeMessageHTML(message)
}

/**
 * 从会话 JSONL 中反序列化出的 API 错误的形状。
 *
 * 经过 JSON 往返后，SDK 的 APIError 会丢失其 `.message` 属性。
 * 实际消息会根据提供方的不同而存在于不同的嵌套层级：
 *
 * - Bedrock/代理: `{ error: { message: "..." } }`
 * - 标准 Limkenion API: `{ error: { error: { message: "..." } } }`
 *   （外层 `.error` 是响应体，内层 `.error` 是 API 错误）
 *
 * 另见：`logging.ts` 中的 `getErrorMessage`，它处理相同的形状。
 */
type NestedAPIError = {
  error?: {
    message?: string
    error?: { message?: string }
  }
}

function hasNestedError(value: unknown): value is NestedAPIError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

/**
 * 从缺少顶层 `.message` 的反序列化 API 错误中提取人类可读消息。
 *
 * 检查两个嵌套层级（更深的优先，以获得更高精确度）：
 * 1. `error.error.error.message` —— 标准 Limkenion API 形状
 * 2. `error.error.message` —— Bedrock 形状
 */
function extractNestedErrorMessage(error: APIError): string | null {
  if (!hasNestedError(error)) {
    return null
  }

  // 通过窄化类型访问 `.error`，让 TypeScript 能看到嵌套形状，
  // 而不是 SDK 的 `Object | undefined`。
  const narrowed: NestedAPIError = error
  const nested = narrowed.error

  // 标准 Limkenion API 形状: { error: { error: { message } } }
  const deepMsg = nested?.error?.message
  if (typeof deepMsg === 'string' && deepMsg.length > 0) {
    const sanitized = sanitizeMessageHTML(deepMsg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  // Bedrock 形状: { error: { message } }
  const msg = nested?.message
  if (typeof msg === 'string' && msg.length > 0) {
    const sanitized = sanitizeMessageHTML(msg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  return null
}

export function formatAPIError(error: APIError): string {
  // 从 cause 链中提取连接错误详情
  const connectionDetails = extractConnectionErrorDetails(error)

  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails

    // 处理超时错误
    if (code === 'ETIMEDOUT') {
      return '请求超时。请检查你的网络连接与代理设置'
    }

    // 用特定消息处理 SSL/TLS 错误
    if (isSSLError) {
      switch (code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          return '无法连接到 API：SSL 证书验证失败。请检查你的代理或公司 SSL 证书'
        case 'CERT_HAS_EXPIRED':
          return '无法连接到 API：SSL 证书已过期'
        case 'CERT_REVOKED':
          return '无法连接到 API：SSL 证书已被吊销'
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return '无法连接到 API：检测到自签名证书。请检查你的代理或公司 SSL 证书'
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
        case 'HOSTNAME_MISMATCH':
          return '无法连接到 API：SSL 证书主机名不匹配'
        case 'CERT_NOT_YET_VALID':
          return '无法连接到 API：SSL 证书尚未生效'
        default:
          return `无法连接到 API：SSL 错误（${code}）`
      }
    }
  }

  if (error.message === 'Connection error.') {
    // 若存在 code 但不是 SSL，为调试将其包含进来
    if (connectionDetails?.code) {
      return `无法连接到 API（${connectionDetails.code}）`
    }
    return '无法连接到 API。请检查你的网络连接'
  }

  // 守卫：从 JSONL 反序列化时（例如 --resume），错误对象可能是一个
  // 没有 `.message` 属性的普通对象。返回安全的回退值而非 undefined，
  // 以免访问 `.length` 的调用方崩溃。
  if (!error.message) {
    return (
      extractNestedErrorMessage(error) ??
      `API 错误（状态码 ${error.status ?? '未知'}）`
    )
  }

  const sanitizedMessage = sanitizeAPIError(error)
  // 若净化后的消息与原始不同（即 HTML 已被净化）就使用它
  return sanitizedMessage !== error.message && sanitizedMessage.length > 0
    ? sanitizedMessage
    : error.message
}
