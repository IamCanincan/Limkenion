/**
 * shell 出网白名单代理（server/netproxy.mjs）。
 *
 * 用**真的 socket 走一遍 CONNECT** —— 代理的语义就是协议语义，mock 等于没测。
 * 覆盖：白名单内建隧道、白名单外 403、三档环境变量的取值。
 *
 * 注意：egress.mjs 在 import 时就读了环境变量，所以白名单**必须在 import 之前**设好。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect as netConnect, Server as TcpServer } from 'node:net'

// 白名单只允许本机 —— 在 import 之前设置
process.env.LIMKENION_EGRESS_ALLOWLIST = '127.0.0.1,*.allowed.test'

let netproxy
let egress

/** 用 CONNECT 走一次代理，返回状态行。 */
function connectViaProxy(proxyPort, host, port) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', d => {
      buf += d.toString()
      if (buf.includes('\r\n\r\n')) {
        const statusLine = buf.split('\r\n')[0]
        sock.destroy()
        resolve(statusLine)
      }
    })
    sock.on('error', reject)
    setTimeout(() => {
      sock.destroy()
      reject(new Error('CONNECT 超时'))
    }, 3000)
  })
}

let echoServer
let proxyPort

before(async () => {
  // 一个回显 TCP 服务，代表"白名单内的目标"
  echoServer = await new Promise(resolve => {
    const s = new TcpServer(socket => {
      socket.on('data', d => socket.write(`echo:${d.toString().slice(0, 32)}`))
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })

  netproxy = await import('../server/netproxy.mjs')
  egress = await import('../server/egress.mjs')
  proxyPort = await netproxy.startShellProxy()
})

after(async () => {
  netproxy?.stopShellProxy()
  echoServer?.close()
})

test('白名单内的主机：CONNECT 建隧道成功', async () => {
  const echoPort = echoServer.address().port
  const status = await connectViaProxy(proxyPort, '127.0.0.1', echoPort)
  assert.match(status, /200/, `应返回 200，实际：${status}`)
})

test('白名单外的主机：直接 403（不做任何转发）', async () => {
  const status = await connectViaProxy(proxyPort, 'not-allowed.invalid', 443)
  assert.match(status, /403/, `应返回 403，实际：${status}`)
})

test('shellNetEnvFor：三档取值正确', () => {
  // off → 死端口
  const off = netproxy.shellNetEnvFor('off')
  assert.match(off.HTTP_PROXY, /127\.0\.0\.1:9/)
  assert.match(off.https_proxy, /127\.0\.0\.1:9/, '大小写两种变量都要设，别漏')

  // allowlist → 指向已启动的代理
  const allow = netproxy.shellNetEnvFor('allowlist')
  assert.equal(allow.HTTP_PROXY, `http://127.0.0.1:${proxyPort}`)

  // 不限制 → 什么都不给
  assert.deepStrictEqual(netproxy.shellNetEnvFor(undefined), {})
})

test('allowlist 模式下代理没起来 → fail closed（退回死端口，不放行）', () => {
  const saved = netproxy.shellProxyPort()
  assert.ok(saved !== null)
  // 模拟"代理还没就绪"：直接停掉
  netproxy.stopShellProxy()
  try {
    const env = netproxy.shellNetEnvFor('allowlist')
    assert.match(env.HTTP_PROXY, /127\.0\.0\.1:9/, '代理不可用时应按断网处理')
  } finally {
    // 恢复，避免影响后续用例
    netproxy.stopShellProxy()
  }
})

test('白名单规则语义：*. 后缀匹配与精确匹配共用一套', () => {
  assert.strictEqual(egress.hostAllowed('127.0.0.1'), true)
  assert.strictEqual(egress.hostAllowed('a.allowed.test'), true, '*.allowed.test 应命中')
  assert.strictEqual(egress.hostAllowed('allowed.test'), false, '*. 不应当匹配裸域名')
  assert.strictEqual(egress.hostAllowed('evil.test'), false)
})
