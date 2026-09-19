/**
 * shell 子进程的**出网白名单代理**。
 *
 * 背景：LIMKENION_WEB_SHELL_NET=off 的做法是给子进程一个指向死端口的代理
 * （curl / npm / pip 这类守规矩的 CLI 会立刻失败）。那是**全有或全无**：
 * 想让 `npm install` 能跑，就得把整个网络打开。
 *
 * 这里加一档 `allowlist`：起一个本进程内的 HTTP 代理，按
 * LIMKENION_EGRESS_ALLOWLIST（与服务端出网**同一套**规则）决定放行还是拒绝，
 * 于是可以"只放开 registry.npmjs.org，其余全拒"。
 *
 * **局限（别吹牛）**：只能拦住**遵守代理环境变量**的客户端。直连原始 socket、
 * 自定义 DNS 的程序照样能出去 —— 那需要 OS 级沙箱（Windows 下无轻量方案）。
 * 这里做的是"把守规矩的那部分管起来"，不是完整的网络隔离。
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect, createServer as createTcpServer } from 'node:net'
import { hostAllowed } from './egress.mjs'

/** @type {import('node:http').Server|null} */
let server = null
let port = /** @type {number|null} */ (null)
let starting = /** @type {Promise<number>|null} */ (null)

/**
 * 启动代理（幂等）。只在需要时调，没开 allowlist 模式就不会起来。
 * @returns {Promise<number>} 监听端口
 */
export function startShellProxy() {
  if (port !== null) return Promise.resolve(port)
  if (starting) return starting

  starting = new Promise((resolve, reject) => {
    server = createServer(handlePlainHttp)
    // CONNECT：HTTPS 走这条
    server.on('connect', handleConnect)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(port)
    })
  })
  return starting
}

/** 当前代理端口（没起来则为 null）。 */
export function shellProxyPort() {
  return port
}

/** 停掉代理（测试用）。 */
export function stopShellProxy() {
  if (server) server.close()
  server = null
  port = null
  starting = null
}

/** CONNECT host:port —— 白名单内就建隧道，否则 403。 */
function handleConnect(req, clientSocket, head) {
  const raw = String(req.url ?? '')
  const idx = raw.lastIndexOf(':')
  const host = (idx > 0 ? raw.slice(0, idx) : raw).trim()
  const targetPort = Number(idx > 0 ? raw.slice(idx + 1) : 443) || 443

  if (!hostAllowed(host)) {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    clientSocket.end()
    return
  }

  const upstream = netConnect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  const bail = () => {
    upstream.destroy()
    clientSocket.destroy()
  }
  upstream.on('error', bail)
  clientSocket.on('error', bail)
}

/**
 * 普通 HTTP 代理（请求行是绝对 URI）。
 * 只转发到白名单内的主机；转发前去掉逐跳首部。
 */
function handlePlainHttp(req, res) {
  let target
  try {
    target = new URL(String(req.url ?? ''))
  } catch {
    res.writeHead(400)
    res.end('bad request')
    return
  }
  if (!hostAllowed(target.hostname)) {
    res.writeHead(403)
    res.end('blocked by allowlist')
    return
  }

  const headers = { ...req.headers }
  delete headers['proxy-connection']
  delete headers['proxy-authorization']

  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: Number(target.port) || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method ?? 'GET',
      headers,
    },
    up => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    res.writeHead(502)
    res.end('upstream error')
  })
  req.pipe(upstream)
}

/**
 * 给子进程用的代理环境变量。
 * @param {'allowlist'|'off'|undefined} mode
 * @returns {Record<string,string>}
 */
export function shellNetEnvFor(mode) {
  if (mode === 'off') {
    // 全断：指向死端口（比代理更彻底，且不需要起服务）
    const dead = 'http://127.0.0.1:9'
    return {
      HTTP_PROXY: dead,
      HTTPS_PROXY: dead,
      ALL_PROXY: dead,
      http_proxy: dead,
      https_proxy: dead,
      all_proxy: dead,
    }
  }
  if (mode === 'allowlist') {
    // 代理还没起来（未初始化 / 启失败了）就**按断网处理** —— fail closed，
    // 不能因为兜底逻辑没准备好就把网络全放开。
    const base = port !== null ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:9'
    return {
      HTTP_PROXY: base,
      HTTPS_PROXY: base,
      ALL_PROXY: base,
      http_proxy: base,
      https_proxy: base,
      all_proxy: base,
    }
  }
  return {}
}

/** 测试辅助：起一个只回固定内容的 TCP 服务，用来验证 CONNECT 隧道真的通。 */
export function _echoServerForTests() {
  return new Promise(resolve => {
    const s = createTcpServer(socket => {
      socket.on('data', d => socket.write(`echo:${d.toString().slice(0, 64)}`))
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}
