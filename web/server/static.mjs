/**
 * HTTP 静态服务：伺服 dist/ 构建产物。
 *
 * 三处加固：
 *   1. 路径校验用「DIST_DIR + 分隔符」比较 —— 原先只 startsWith(DIST_DIR)，
 *      `dist-evil` 这类同前缀兄弟目录能绕过（虽然当前不可利用，但属于硬伤）；
 *   2. 统一安全响应头（nosniff / CSP / 禁 referrer / 禁被 iframe 嵌套）；
 *   3. 伺服 index.html 时注入本次运行的一次性 WS token。
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { DIST_DIR } from './config.mjs'
import { injectToken, isLocalOrigin, SECURITY_HEADERS, WS_TOKEN, httpGate, gatePage } from './security.mjs'
import { latestReport, readReport } from './insights.mjs'
import { handleMcpOAuthCallback } from './mcpOAuth.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** dist 根 + 分隔符，用于精确的包含判断。 */
const DIST_PREFIX = normalize(DIST_DIR).endsWith(sep) ? normalize(DIST_DIR) : normalize(DIST_DIR) + sep

function respond(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

/** index.html：读盘后注入 token（不缓存，token 每次启动都变）。 */
async function serveIndex(res) {
  try {
    const raw = await readFile(join(DIST_DIR, 'index.html'), 'utf8')
    respond(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, injectToken(raw))
  } catch {
    respond(
      res,
      503,
      { 'content-type': 'text/plain; charset=utf-8' },
      'Limkenion web 前端尚未构建。请先执行：cd web && npm run build',
    )
  }
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    try {
    if (req.url === undefined) {
      respond(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad Request')
      return
    }

    let urlPath
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0])
    } catch {
      respond(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad Request')
      return
    }

    // 只处理 GET/HEAD（静态服务没有需要变更状态的接口）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method Not Allowed')
      return
    }
    // 反斜杠在 Windows 上也是分隔符，统一成正斜杠再判断

    // 局域网暴露（非环回绑定）时：所有页面先过 HTTP 闸门。OAuth 回调豁免
    // （授权提供方跳转回来时不保证已带 cookie；回调页本身无敏感内容）。
    if (urlPath !== '/mcp/oauth/callback') {
      const gate = httpGate(req)
      if (!gate.ok) {
        const u = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`)
        const qt = u.searchParams.get('token')
        if (qt === WS_TOKEN) {
          // 凭据正确 → 下发 cookie 并重定向到目标页（URL 上不留 token）
          respond(res, 302, {
            'set-cookie': `limkenion-auth=${WS_TOKEN}; HttpOnly; Path=/; SameSite=Lax`,
            location: urlPath,
          }, '')
          return
        }
        respond(res, 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, gatePage())
        return
      }
    }
    urlPath = urlPath.split('\\').join('/')

    // 开发模式（Vite 5173 伺服页面）拿不到注入的 meta，改从这条路取 token。
    // 只允许本机来源读取：跨站页面虽然能发请求，但没有 CORS 头读不到响应体。
    if (urlPath === '/ws-token') {
      if (!isLocalOrigin(req.headers.origin, req.headers.host)) {
        respond(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden')
        return
      }
      respond(
        res,
        200,
        { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        JSON.stringify({ token: WS_TOKEN }),
      )
      return
    }

    if (urlPath === '/' || urlPath === '') {
      await serveIndex(res)
      return
    }

    // /insights 报告（CLI 那边给的是 file:// 链接，web 端用 HTTP 提供）。
    // 名字必须过 insights.mjs 的白名单（严格的文件名正则 + 落在目录内），
    // 这里不做任何路径拼接的自由发挥。
    // MCP OAuth 回调：浏览器授权后落地在这里，code 换 token 存盘后自动重连。
    if (urlPath === '/mcp/oauth/callback') {
      const u = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`)
      const html = await handleMcpOAuthCallback(u.searchParams)
      respond(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, html)
      return
    }
    if (urlPath === '/insights' || urlPath === '/insights/') {
      const name = await latestReport()
      if (!name) {
        respond(
          res,
          404,
          { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          '还没有生成过洞察报告。在对话里执行 /insights 生成。',
        )
        return
      }
      const html = await readReport(name)
      if (!html) {
        respond(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not Found')
        return
      }
      respond(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, html)
      return
    }
    if (urlPath.startsWith('/insights/')) {
      const html = await readReport(urlPath.slice('/insights/'.length))
      if (!html) {
        respond(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not Found')
        return
      }
      respond(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, html)
      return
    }

    const filePath = normalize(join(DIST_DIR, urlPath))
    // 精确包含：必须落在 dist 目录内部，且不能是 dist 本身
    if (filePath !== normalize(DIST_DIR) && !filePath.startsWith(DIST_PREFIX)) {
      respond(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden')
      return
    }

    try {
      const st = await stat(filePath)
      if (!st.isFile()) {
        // 目录请求 → SPA 回退
        await serveIndex(res)
        return
      }
      const ext = extname(filePath)
      if (ext === '.html') {
        await serveIndex(res)
        return
      }
      const body = await readFile(filePath)
      respond(
        res,
        200,
        {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': ext === '.map' ? 'no-store' : 'public, max-age=3600',
        },
        body,
      )
    } catch {
      // 未命中 → SPA 回退（前端路由）
      await serveIndex(res)
    }
    } catch (err) {
      // 任何意料之外的错误（OAuth 换 token 的网路失败、报告/更新读盘异常等）都不能让
      // 这条请求「永远拿不到响应」——否则客户端挂起，且在装 crashGuard 之前还会成为
      // 未处理的拒绝把整个服务打死。这里统一回 500（crashGuard 是进程级兜底，这里保证
      // 单条请求也能拿到响应而不是干等超时）。
      console.error('[http] 处理请求时未捕获的异常（已回 500）：', err)
      if (!res.headersSent) {
        respond(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'Internal Server Error')
      }
    }
  })
}
