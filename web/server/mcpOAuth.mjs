/**
 * MCP 远程服务器的 OAuth 2.1 授权（web 端）。
 *
 * 流程（对齐 MCP 规范的 auth 部分）：
 * 1. 连接服务器拿到 401 → 从 WWW-Authenticate 读 protected resource metadata，
 *    再读授权服务器元数据（RFC 8414）；配置里写死了 auth 端点则跳过发现。
 * 2. 有 registration_endpoint 就动态注册客户端（PKCE + 无 secret）；否则用配置给的 clientId。
 * 3. 生成授权链接（code_challenge = S256）—— 播报给前端 + 尝试自动开浏览器。
 * 4. 用户浏览器登录后回到本服务的 GET /mcp/oauth/callback，用 code 换 token 落盘。
 * 5. 之后该服务器的请求自动带上 Bearer；过期用 refresh_token 续。
 *
 * 令牌按服务器名存 `STATE_DIR/mcp-oauth.json`（本机文件，仅回环服务可读）。
 * 依赖方向：只 import sessions（STATE_DIR）/bus，谁都不反向依赖它。
 */
import { createHash, randomBytes } from 'node:crypto'
import { fetch as guardedFetch } from './egress.mjs'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from './sessions.mjs'
import { broadcast } from './bus.mjs'

const TOKEN_FILE = join(STATE_DIR, 'mcp-oauth.json')
/** 授权链接在内存里等回调；状态 → {cfg, verifier, redirectUri} */
const pendingAuth = new Map()

/**
 * 待授权请求的存活时间。
 *
 * 用户打开浏览器授权页后**关掉或走开**，回调永远不会来，而原先只在回调里
 * `pendingAuth.delete(state)` —— 那条 state 就永久占在 map 里（还带着 cfg /
 * verifier）。设个 TTL，在相关入口顺手清掉过期的。
 */
const AUTH_PENDING_TTL_MS = 10 * 60 * 1000

/** 清掉超时的待授权请求（用户放弃浏览器授权时的残留）。 */
function purgeExpiredAuth() {
  const now = Date.now()
  for (const [state, p] of pendingAuth) {
    if (now - (p.createdAt ?? 0) > AUTH_PENDING_TTL_MS) pendingAuth.delete(state)
  }
}
const authorizedListeners = new Set()

let tokensCache = null
let tokensLoaded = false

async function loadTokens() {
  if (tokensLoaded) return tokensCache
  tokensLoaded = true
  try {
    tokensCache = JSON.parse(await readFile(TOKEN_FILE, 'utf8'))
  } catch {
    tokensCache = {}
  }
  return tokensCache
}

async function saveTokens() {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(TOKEN_FILE, JSON.stringify(tokensCache, null, 1), 'utf8')
}

/**
 * 强制续期（不等自然过期）：401 重试路径用。
 * @returns {Promise<string|null>} 新的 access_token；没法续（无 refresh_token / 刷新失败）→ null
 */
export async function forceRefresh(name) {
  const tokens = await loadTokens()
  const t = tokens[name]
  if (!t?.refresh_token) return null
  try {
    const refreshed = await exchangeToken(t.token_url, {
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.client_id,
    })
    t.access_token = refreshed.access_token
    t.expires_at = Date.now() + (refreshed.expires_in ?? 3600) * 1000
    if (refreshed.refresh_token) t.refresh_token = refreshed.refresh_token
    await saveTokens()
    return t.access_token
  } catch {
    return null
  }
}

/** 服务器是否正在等用户完成浏览器授权。 */
export function isAuthorizationPending(name) {
  purgeExpiredAuth()
  for (const p of pendingAuth.values()) if (p.cfg.name === name) return true
  return false
}

/** 授权成功后的重连钩子（mcp.mjs 注册）。 */
export function onAuthorized(fn) {
  authorizedListeners.add(fn)
}

const b64url = buf => Buffer.from(buf).toString('base64url')

/**
 * 拿某服务器当前可用的 Bearer（没有/已过期且无法续 → null）。
 * 过期但有 refresh_token 就同步续一次（带互斥，防并发重复续）。
 */
export async function bearerFor(name) {
  const tokens = await loadTokens()
  const t = tokens[name]
  if (!t) return null
  if (t.expires_at && Date.now() > t.expires_at - 60_000 && t.refresh_token) {
    if (!t._refreshing) {
      t._refreshing = true
      try {
        const refreshed = await exchangeToken(t.token_url, {
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
          client_id: t.client_id,
        })
        Object.assign(t, {
          access_token: refreshed.access_token,
          expires_at: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
          ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
        })
        await saveTokens()
      } catch {
        // 续期失败：下次连接走全新授权
      } finally {
        t._refreshing = false
      }
    }
  }
  return t.access_token ?? null
}

/** 从 WWW-Authenticate / 服务元数据做端点发现。失败返回 null（调用方给出可读的错误）。 */
async function discoverEndpoints(url) {
  // 1) 主动请求一次，看 401 的 WWW-Authenticate 里有没有 resource_metadata
  let prmUrl = null
  try {
    const probe = await guardedFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (probe.status === 401) {
      const www = probe.headers.get('www-authenticate') ?? ''
      const m = www.match(/resource_metadata="([^"]+)"/)
      if (m) prmUrl = m[1]
    }
  } catch { /* 探测失败不致命，走下面的兜底 */ }

  // 2) 受保护资源元数据 → authorization_servers[0]
  let asBase = null
  if (prmUrl) {
    try {
      const prm = /** @type {{authorization_servers?: string[]}} */ (
        await (await guardedFetch(prmUrl, { signal: AbortSignal.timeout(10_000) })).json()
      )
      asBase = Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : null
    } catch { /* 兜底 */ }
  }

  // 3) 授权服务器元数据（RFC 8414；非根路径要插路径段，这里两个都试）
  const candidates = []
  if (asBase) {
    const u = new URL(asBase)
    candidates.push(`${u.origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`)
    candidates.push(`${asBase}/.well-known/oauth-authorization-server`)
  } else {
    const u = new URL(url)
    candidates.push(`${u.origin}/.well-known/oauth-authorization-server`)
  }
  for (const c of candidates) {
    try {
      const meta = /** @type {{authorization_endpoint?: string, token_endpoint?: string, registration_endpoint?: string, scopes_supported?: string[]}} */ (
        await (await guardedFetch(c, { signal: AbortSignal.timeout(10_000) })).json()
      )
      if (meta.authorization_endpoint && meta.token_endpoint) return meta
    } catch { /* 试下一个 */ }
  }
  return null
}

/**
 * 启动一次浏览器授权。返回授权 URL（同时播报给前端 + 尝试自动开浏览器）。
 * @param {object} cfg mcpServers 里的一条（name/url/auth?）
 */
export async function startAuthorization(cfg) {
  const userAuth = cfg.auth ?? {}
  /** @type {{authorization_endpoint?: string, token_endpoint?: string, registration_endpoint?: string, scopes_supported?: string[]} | null} */
  let endpoints = null
  if (userAuth.authorizationUrl && userAuth.tokenUrl) {
    endpoints = /** @type {NonNullable<typeof endpoints>} */ ({ authorization_endpoint: userAuth.authorizationUrl, token_endpoint: userAuth.tokenUrl })
  } else {
    endpoints = await discoverEndpoints(cfg.url)
  }
  if (!endpoints && !(userAuth.authorizationUrl && userAuth.tokenUrl)) {
    throw new Error(
      `无法发现「${cfg.name}」的 OAuth 端点。可在 mcpServers 配置里手写 auth: ` +
        '{ authorizationUrl, tokenUrl, clientId?, scopes? }',
    )
  }
  const ep = /** @type {NonNullable<typeof endpoints>} */ (endpoints)

  // 动态注册客户端（服务器支持时）；否则必须配置里给 clientId
  let clientId = userAuth.clientId
  if (!clientId && ep.registration_endpoint) {
    const redirectUri = redirectUriFor(cfg)
    const reg = await (
      await guardedFetch(ep.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Limkenion Web',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(10_000),
      })
    ).json()
    const regBody = /** @type {{client_id?: string, client_secret?: string}} */ (reg)
    clientId = regBody.client_id
    if (clientId && regBody.client_secret) userAuth.clientSecret = regBody.client_secret
  }
  if (!clientId) {
    throw new Error(`「${cfg.name}」既不支持动态注册，配置里也没给 auth.clientId`)
  }

  // PKCE 校验值 + state（state 防 CSRF，且用于把回调对回本次待授权请求）
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const redirectUri = redirectUriFor(cfg)
  purgeExpiredAuth()
  pendingAuth.set(state, { cfg, verifier, redirectUri, clientId, tokenUrl: ep.token_endpoint, createdAt: Date.now() })

  const scope = userAuth.scopes ?? (Array.isArray(ep.scopes_supported) ? ep.scopes_supported.join(' ') : undefined)
  const u = new URL(/** @type {string} */ (ep.authorization_endpoint))
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  if (scope) u.searchParams.set('scope', scope)
  const authorizeUrl = u.toString()

  broadcast({
    type: 'notice',
    text: `MCP 服务器「${cfg.name}」需要授权。请在浏览器打开：${authorizeUrl}`,
  })
  openBrowser(authorizeUrl)
  return authorizeUrl
}

/** 浏览器回来落地的地址（本机回环 + 固定路径）。 */
function redirectUriFor(cfg) {
  const port = Number(process.env.LIMKENION_WEB_PORT) || 8788
  return `http://127.0.0.1:${port}/mcp/oauth/callback`
}

function openBrowser(url) {
  try {
    const opts = /** @type {import('node:child_process').SpawnOptions} */ ({ detached: true, stdio: 'ignore' })
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], opts).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opts).unref()
    } else {
      spawn('xdg-open', [url], opts).unref()
    }
  } catch { /* 打不开就靠播报里的链接 */ }
}

/**
 * @param {string} tokenUrl
 * @param {Record<string,string>} params
 * @returns {Promise<{access_token: string, refresh_token?: string, expires_in?: number, [k:string]: unknown}>}
 */
async function exchangeToken(tokenUrl, params) {
  const res = await guardedFetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`token 端点返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`)
  }
  return /** @type {any} */ (await res.json())
}

/**
 * OAuth 回调（static.mjs 的 /mcp/oauth/callback 路由调用）。
 * @returns {Promise<string>} 给浏览器的 HTML
 */
export async function handleMcpOAuthCallback(searchParams) {
  purgeExpiredAuth()
  const state = searchParams.get('state')
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const pending = state ? pendingAuth.get(state) : null
  const page = (title, body) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:sans-serif;text-align:center;padding-top:10vh"><h2>${title}</h2><p>${body}</p></body>`
  if (error) {
    pendingAuth.delete(state)
    return page('授权被拒绝', `${error}（可关闭此页，回到 web 重试）`)
  }
  if (!pending || !code) return page('授权回调无效', 'state 对不上或缺少 code，请回到 web 重新发起授权。')
  pendingAuth.delete(state)

  const tok = await exchangeToken(pending.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  })
  const tokens = await loadTokens()
  tokens[pending.cfg.name] = {
    access_token: tok.access_token,
    ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
    client_id: pending.clientId,
    token_url: pending.tokenUrl,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  }
  await saveTokens()
  for (const fn of authorizedListeners) {
    try {
      fn(pending.cfg)
    } catch { /* 监听者自己的问题 */ }
  }
  return page('授权成功', `MCP 服务器「${pending.cfg.name}」已连接授权，可关闭此页回到 web。`)
}
