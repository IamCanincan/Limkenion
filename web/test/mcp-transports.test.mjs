/**
 * MCP 新传输 + OAuth 测试。
 *
 * - SSE 传输：用真的 SSE 桩服务器走完整链路（握手 → 工具清单 → 调用），
 *   传输/事件解析正是容易出错的地方，不 mock。
 * - elicitation：服务器反问 → 前端问答弹窗 → 应答回传（用 resolveQuestions 模拟作答）。
 * - OAuth：发现（401 + resource metadata + AS metadata）→ 动态注册 → PKCE 授权 URL →
 *   回调换 token → bearerFor 取到。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fakeClient } from './helpers.mjs'

let configDir
let ws
let mcp
let interactions
let sessions
let oauth
let bus
let client
let sseStub
let ssePort
let authStub
let authPort
let authSeen = { registered: null, tokenRequests: [] }
let questionsAnswered = []

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-mcpx-cfg-'))
  ws = await mkdtemp(join(tmpdir(), 'lk-mcpx-ws-'))
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.LIMKENION_WEB_PORT = '8891' // OAuth 回调 redirect_uri 要用到

  bus = await import('../server/bus.mjs')
  client = fakeClient({
    onQuestion: msg => {
      // 模拟用户在弹窗里选「红」（按问题头字段定位）
      questionsAnswered.push(msg.requestId)
      const { resolveQuestions } = interactions
      resolveQuestions(msg.requestId, msg.questions.map(q => ({ question: q.question, answer: q.header === 'color' ? '红' : '随便' })))
      return []
    },
  })
  bus.addClient(client.ws)

  sessions = await import('../server/sessions.mjs')
  interactions = await import('../server/interactions.mjs')
  oauth = await import('../server/mcpOAuth.mjs')

  sseStub = await startSseStub()
  ssePort = sseStub.port
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({ mcpServers: { sse1: { type: 'sse', url: `http://127.0.0.1:${ssePort}/sse` } } }, null, 1),
    'utf8',
  )
  mcp = await import('../server/mcp.mjs')
})

after(async () => {
  mcp?.closeAllMcp()
  sseStub?.close()
  authStub?.close()
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  await rm(configDir, { recursive: true, force: true }).catch(() => {})
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 旧版 HTTP+SSE 桩：见 fixtures/mcp-sse-stub-server.mjs（这里内联为子进程太重，直接起 http 服务） */
async function startSseStub() {
  const { createServer } = await import('node:http')
  let push = null
  let pendingCallId = null
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      push = m => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`)
      res.write(`event: endpoint\ndata: http://127.0.0.1:${server.address().port}/message\n\n`)
      req.on('close', () => { push = null })
      return
    }
    if (req.method === 'POST' && req.url.startsWith('/message')) {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        res.writeHead(202)
        res.end()
        const msg = JSON.parse(body)
        if (msg.method === 'initialize') {
          push({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'sse-stub' }, capabilities: { tools: {} } } })
        } else if (msg.method === 'tools/list') {
          push({
            jsonrpc: '2.0', id: msg.id,
            result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }, { name: 'ask_color', inputSchema: { type: 'object' } }] },
          })
        } else if (msg.method === 'tools/call' && msg.params.name === 'echo') {
          push({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments?.text ?? '') }] } })
        } else if (msg.method === 'tools/call' && msg.params.name === 'ask_color') {
          pendingCallId = msg.id
          push({
            jsonrpc: '2.0', id: 'srv-elic-1', method: 'elicitation/create',
            params: { message: '选个颜色', requestedSchema: { properties: { color: { type: 'string', enum: ['红', '蓝'] } } } },
          })
        } else if (msg.id === 'srv-elic-1' && msg.result?.action === 'accept') {
          if (pendingCallId !== null) {
            push({ jsonrpc: '2.0', id: pendingCallId, result: { content: [{ type: 'text', text: '你选了：' + (msg.result.content?.color ?? '?') }] } })
            pendingCallId = null
          }
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, close: () => server.close() }
}

describe('SSE 传输（真服务器，完整链路）', () => {
  test('握手 + 工具清单 + 调用', async () => {
    const r = await mcp.reloadMcp()
    assert.equal(r.connected, 1, `sse1 应连接成功：${JSON.stringify(r)}`)
    const s = sessions.createSession()
    const out = await mcp.callMcpTool('mcp__sse1__echo', { text: 'hi' }, s)
    assert.match(String(out), /echo:hi/)
  })

  test('服务端反问 elicitation → 弹窗作答回传', async () => {
    const s = sessions.createSession()
    const out = await mcp.callMcpTool('mcp__sse1__ask_color', {}, s)
    assert.match(String(out), /你选了：红/, `应带上弹窗里选的答案：${out}`)
    assert.ok(questionsAnswered.length > 0, '应先弹过问答')
  })
})

describe('OAuth（发现 → 注册 → 授权链接 → 回调 → bearer）', () => {
  test('全流程', async () => {
    // 授权服务器 + 受保护资源元数据桩
    authStub = createServer((req, res) => {
      const u = new URL(req.url, 'http://x')
      const sendJson = obj => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (u.pathname === '/mcp') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="http://127.0.0.1:${authPort}/.well-known/oauth-protected-resource"`,
        })
        res.end()
        return
      }
      if (u.pathname === '/.well-known/oauth-protected-resource') {
        sendJson({ authorization_servers: [`http://127.0.0.1:${authPort}`] })
        return
      }
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        sendJson({
          authorization_endpoint: `http://127.0.0.1:${authPort}/authorize`,
          token_endpoint: `http://127.0.0.1:${authPort}/token`,
          registration_endpoint: `http://127.0.0.1:${authPort}/register`,
          scopes_supported: ['mcp:read'],
        })
        return
      }
      if (u.pathname === '/register') {
        let body = ''
        req.on('data', d => (body += d))
        req.on('end', () => {
          authSeen.registered = JSON.parse(body)
          sendJson({ client_id: 'dyn-123' })
        })
        return
      }
      if (u.pathname === '/token') {
        let body = ''
        req.on('data', d => (body += d))
        req.on('end', () => {
          authSeen.tokenRequests.push(new URLSearchParams(body))
          sendJson({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise(resolve => authStub.listen(0, '127.0.0.1', resolve))
    authPort = authStub.address().port

    // 1) 发起授权：走完发现 + 动态注册 + PKCE
    const url = await oauth.startAuthorization({ name: 'oauth1', url: `http://127.0.0.1:${authPort}/mcp` })
    assert.ok(url.includes('/authorize'), `授权 URL 应指向 authorize 端点：${url}`)
    assert.ok(url.includes('client_id=dyn-123'), '应完成动态注册并带上 client_id')
    assert.ok(url.includes('code_challenge='), '应带 PKCE challenge')
    assert.ok(url.includes('scope=mcp%3Aread'), '应带发现到的 scope')

    // 2) 回调换 token
    const state = new URL(url).searchParams.get('state')
    assert.ok(state, '授权 URL 应带 state')
    const html = await oauth.handleMcpOAuthCallback(new URLSearchParams({ state, code: 'code-1' }))
    assert.match(html, /授权成功/)
    assert.equal(authSeen.tokenRequests.length, 1, 'code 应被拿去换 token')
    assert.equal(authSeen.tokenRequests[0].get('code_verifier').length >= 43, true, 'PKCE verifier 应足够长')

    // 3) bearer 可用
    assert.equal(await oauth.bearerFor('oauth1'), 'at-1')
  })

  test('未授权的服务器 bearerFor → null', async () => {
    assert.equal(await oauth.bearerFor('nobody'), null)
  })
})
