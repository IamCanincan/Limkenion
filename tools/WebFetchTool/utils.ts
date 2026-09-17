import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryHaiku } from '../../services/api/limkenion.js'
import { AbortError } from '../../utils/errors.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { isPreapprovedHost } from './preapproved.js'
import { makeSecondaryModelPrompt } from './prompt.js'

// 域名阻断的自定义错误类
class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(`Limkenion is unable to fetch from ${domain}`)
    this.name = 'DomainBlockedError'
  }
}

class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(
      `Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking limkenion.ai.`,
    )
    this.name = 'DomainCheckFailedError'
  }
}

class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

// 用于存储已抓取 URL 内容的缓存
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// 缓存，TTL 15 分钟，大小上限 50MB
// LRUCache 负责自动过期与淘汰
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 分钟
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

// 用于预检域名检查的独立缓存。URL_CACHE 以 URL 为键，因此
// 抓取同一域名下的两个路径会触发两次相同的
// 到 127.0.0.1 的预检 HTTP 往返。这个以主机名为键的缓存避免了
// 这一点。只缓存 'allowed' —— blocked/failed 会在下次尝试时重新检查。
const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: 128,
  ttl: 5 * 60 * 1000, // 5 分钟 —— 比 URL_CACHE 的 TTL 更短
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
  DOMAIN_CHECK_CACHE.clear()
}

// 惰性单例 —— 将 turndown → @mixmark-io/domino 的导入（约 1.4MB
// 常驻堆）推迟到首次抓取 HTML 时，并在多次调用间复用同一个实例
// （构造会创建 15 个规则对象；.turndown() 是无状态的）。
// @types/turndown 只提供 `export =`（没有 .d.mts），因此 TS 将该导入类型化为
// 类本身，而 Bun 会把 CJS 包装成 { default } —— 所以需要这个类型转换。
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// PSR 曾要求将 URL 长度限制为 250，以降低数据外泄的
// 可能性。然而，这对某些客户的合法用例过于严格，
// 例如 JWT 签名的 URL（例如云服务签名 URL）
// 可能长得多。我们已经要求对每个域名获得用户批准，
// 这提供了主要的安全边界。此外，Limkenion 还有
// 其他数据外泄渠道，而这一渠道风险似乎相对不高，
// 因此我移除了该长度限制。 -ab
const MAX_URL_LENGTH = 2000

// 依据 PSR：
// "实现资源消耗控制，因为对 Web Fetch 工具设置 CPU、
// 内存和网络使用限制，可以防止单个
// 请求或用户压垮系统。"
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// 主 HTTP 抓取请求的超时（60 秒）。
// 防止在缓慢/无响应的服务器上无限期挂起。
const FETCH_TIMEOUT_MS = 60_000

// 域名黑名单预检的超时（10 秒）。
const DOMAIN_CHECK_TIMEOUT_MS = 10_000

// 限制同主机重定向跳数。否则恶意服务器可以返回
// 重定向循环（/a → /b → /a …），而每次跳转都会重置
// 每请求的 FETCH_TIMEOUT_MS，导致工具挂起直到用户中断。10 与
// 常见客户端默认值一致（axios=5、follow-redirects=21、Chrome=20）。
const MAX_REDIRECTS = 10

// 截断以避免消耗过多 token
export const MAX_MARKDOWN_LENGTH = 100_000

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // 这里无需检查协议，因为发起请求时我们会把 http 升级为 https

  // 只要我们并不打算支持 cookie 或内部域名，
  // 也就应该阻断带用户名/密码的 URL，尽管这类情况
  // 看起来极不可能出现。
  if (parsed.username || parsed.password) {
    return false
  }

  // 初始过滤：通过检查主机名是否可公开解析，
  // 判断这不是一个特权、公司内部的 URL
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

type DomainCheckResult =
  | { status: 'allowed' }
  | { status: 'blocked' }
  | { status: 'check_failed'; error: Error }

export async function checkDomainBlocklist(
  domain: string,
): Promise<DomainCheckResult> {
  if (DOMAIN_CHECK_CACHE.has(domain)) {
    return { status: 'allowed' }
  }
  try {
    const response = await axios.get(
      `https://127.0.0.1/api/web/domain_info?domain=${encodeURIComponent(domain)}`,
      { timeout: DOMAIN_CHECK_TIMEOUT_MS },
    )
    if (response.status === 200) {
      if (response.data.can_fetch === true) {
        DOMAIN_CHECK_CACHE.set(domain, true)
        return { status: 'allowed' }
      }
      return { status: 'blocked' }
    }
    // 状态非 200 但没有抛错
    return {
      status: 'check_failed',
      error: new Error(`Domain check returned status ${response.status}`),
    }
  } catch (e) {
    logError(e)
    return { status: 'check_failed', error: e as Error }
  }
}

/**
 * 检查某个重定向是否可安全跟随
 * 允许以下重定向：
 * - 在主机名中增加或移除 "www."
 * - 保持源相同但改变路径/查询参数
 * - 或以上两者兼有
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // 现在检查主机名条件
    // 1. 允许添加 www.：example.com -> www.example.com
    // 2. 允许移除 www.：www.example.com -> example.com
    // 3. 允许同一主机（带或不带 www.）：路径可以变化
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * 用于在自定义重定向处理下抓取 URL 的辅助函数
 * 如果重定向通过 redirectChecker 函数检查，则递归跟随
 *
 * 依据 PSR：
 * "不要自动跟随重定向，因为跟随重定向可能
 * 让攻击者利用受信任域名中的开放重定向漏洞，
 * 迫使用户在不知情的情况下向恶意域名
 * 发起请求"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }
  try {
    return await axios.get(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    })
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header')
      }

      // 基于原始 URL 解析相对 URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // 递归跟随被允许的重定向
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // 向调用方返回重定向信息
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // 检测出站代理阻断：当出站受限时，代理会返回 403 并带上
    // X-Proxy-Error: blocked-by-allowlist
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // 检查缓存（LRUCache 自动处理 TTL）
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // 如需要则把 http 升级为 https
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    // 检查用户是否选择跳过黑名单检查
    // 这面向那些安全策略严格、
    // 禁止向 limkenion.ai 建立出站连接的企业客户
    const settings = getSettings_DEPRECATED()
    if (!settings.skipWebFetchPreflight) {
      const checkResult = await checkDomainBlocklist(hostname)
      switch (checkResult.status) {
        case 'allowed':
          // 继续执行抓取
          break
        case 'blocked':
          throw new DomainBlockedError(hostname)
        case 'check_failed':
          throw new DomainCheckFailedError(hostname)
      }
    }

    
  } catch (e) {
    if (
      e instanceof DomainBlockedError ||
      e instanceof DomainCheckFailedError
    ) {
      // 预期内的用户可见失败 - 直接重新抛出，不记录为内部错误
      throw e
    }
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // 检查是否收到了重定向响应
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // 释放 axios 持有的 ArrayBuffer 副本；现在字节归 rawBuffer 所有。
  // 这样 GC 可以在 Turndown 构建 DOM 树（可能是 HTML 大小的 3-5 倍）
  // 之前回收最多 MAX_HTTP_CONTENT_LENGTH（10MB）。
  ;(response as { data: unknown }).data = null
  const contentType = response.headers['content-type'] ?? ''

  // 二进制内容：以恰当的扩展名把原始字节保存到磁盘，以便 Limkenion
  // 之后检查该文件。我们仍会落入下面的 utf-8 解码 +
  // Haiku 路径 —— 尤其对 PDF 而言，解码后的字符串有足够的
  // ASCII 结构（/Title、文本流）让 Haiku 能够总结，而
  // 保存的文件是补充而非替代。
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    markdownContent = (await getTurndownService()).turndown(htmlContent)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // 它不是 HTML - 直接原样使用。解码后字符串的 UTF-8 字节
    // 长度等于 rawBuffer.length（无效字节上的 U+FFFD 替换会造成
    // 少量偏差 —— 对缓存淘汰计量可忽略），因此跳过 O(n) 的
    // Buffer.byteLength 扫描。
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // 将抓取到的内容存入缓存。注意它存储在
  // 原始 URL 下，而不是升级后或重定向后的 URL。
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // lru-cache 要求正整数；对空响应钳制为 1。
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // 截断内容以避免二级模型报出 "Prompt is too long" 错误
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(
    truncatedContent,
    prompt,
    isPreapprovedDomain,
  )
  const assistantMessage = await queryHaiku({
    systemPrompt: asSystemPrompt([]),
    userPrompt: modelPrompt,
    signal,
    options: {
      querySource: 'web_fetch_apply',
      agents: [],
      isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  // 我们需要把它向上抛出，使工具调用抛错，从而向服务端返回
  // 一个 is_error 的 tool_use 块，并在 UI 中渲染一个红点。
  if (signal.aborted) {
    throw new AbortError()
  }

  const { content } = assistantMessage.message
  if (content.length > 0) {
    const contentBlock = content[0]
    if ('text' in contentBlock!) {
      return contentBlock.text
    }
  }
  return 'No response from model'
}
